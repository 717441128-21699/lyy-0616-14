const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const RoomManager = require('./RoomManager');
const SFU = require('./SFU');

const PORT = process.env.PORT || 8080;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const roomManager = new RoomManager();
const sfu = new SFU();

app.use(express.static(path.join(__dirname, '..', 'public')));

const clients = new Map();

sfu.on('packet', ({ receiverId, senderId, trackId, kind, packet, routeKey }) => {
  const client = clients.get(receiverId);
  if (client && client.ws && client.ws.readyState === WebSocket.OPEN) {
    try {
      client.ws.send(JSON.stringify({
        type: 'sfu_media_packet',
        from: senderId,
        trackId,
        kind,
        data: packet.toString
          ? packet.toString('base64')
          : (typeof packet === 'string' ? packet : JSON.stringify(packet)),
        ts: Date.now()
      }));
    } catch (e) {
      console.error(`[SFU] 发送媒体包到 ${receiverId} 失败:`, e.message);
    }
  }
});

sfu.on('stats', ({ receiverId, senderId, trackId, kind, stats }) => {
  const client = clients.get(receiverId);
  if (client && client.ws && client.ws.readyState === WebSocket.OPEN) {
    try {
      client.ws.send(JSON.stringify({
        type: 'sfu_media_stats',
        from: senderId,
        trackId,
        kind,
        stats
      }));
    } catch (e) {}
  }
});

function handleMessage(ws, rawData) {
  let msg;
  try {
    msg = JSON.parse(rawData);
  } catch (e) {
    console.error('[Signaling] 解析消息失败:', e.message);
    sendError(ws, 'INVALID_JSON', '消息格式错误');
    return;
  }

  const { type } = msg;
  const clientId = ws.clientId;

  switch (type) {
    case 'join':
      handleJoin(ws, msg);
      break;
    case 'leave':
      handleLeave(ws, msg);
      break;
    case 'offer':
      handleOffer(ws, msg);
      break;
    case 'answer':
      handleAnswer(ws, msg);
      break;
    case 'ice_candidate':
      handleIceCandidate(ws, msg);
      break;
    case 'sfu_publish':
      handleSfuPublish(ws, msg);
      break;
    case 'sfu_unpublish':
      handleSfuUnpublish(ws, msg);
      break;
    case 'sfu_subscribe':
      handleSfuSubscribe(ws, msg);
      break;
    case 'sfu_unsubscribe':
      handleSfuUnsubscribe(ws, msg);
      break;
    case 'sfu_media_packet_in':
      handleSfuMediaPacketIn(ws, msg);
      break;
    case 'chat':
      handleChat(ws, msg);
      break;
    case 'ping':
      send(ws, { type: 'pong', ts: Date.now() });
      break;
    case 'get_room_info':
      handleGetRoomInfo(ws, msg);
      break;
    default:
      console.warn(`[Signaling] 未知消息类型: ${type} 来自 ${clientId}`);
      sendError(ws, 'UNKNOWN_TYPE', `未知消息类型: ${type}`);
  }
}

function handleJoin(ws, msg) {
  const { roomId, displayName } = msg;
  if (!roomId) {
    sendError(ws, 'MISSING_ROOM_ID', '缺少 roomId');
    return;
  }

  if (!ws.clientId) {
    ws.clientId = uuidv4().slice(0, 12);
  }

  const clientId = ws.clientId;
  const client = {
    id: clientId,
    ws,
    roomId,
    displayName: displayName || `用户-${clientId.slice(0, 4)}`,
    joinedAt: Date.now(),
    publishedTracks: new Set(),
    subscribedTo: new Set()
  };

  clients.set(clientId, client);
  ws.clientInfo = client;

  const existingClientIds = roomManager.getClientIds(roomId);
  const room = roomManager.joinRoom(roomId, client);

  sfu.registerClient(clientId, roomId);

  send(ws, {
    type: 'joined',
    clientId,
    roomId,
    displayName: client.displayName,
    peers: existingClientIds.map(id => {
      const c = clients.get(id);
      return {
        clientId: id,
        displayName: c ? c.displayName : id
      };
    }),
    timestamp: Date.now()
  });

  roomManager.broadcastToRoom(roomId, {
    type: 'peer_joined',
    clientId,
    displayName: client.displayName,
    timestamp: Date.now()
  }, clientId);

  if (existingClientIds.length > 0) {
    sfu.setupFullMeshRoutes(roomId, existingClientIds, clientId);

    send(ws, {
      type: 'sfu_route_info',
      roomId,
      routes: {
        incomingPublishers: existingClientIds,
        outgoingSubscribers: existingClientIds
      }
    });

    for (const publisherId of existingClientIds) {
      send(ws, {
        type: 'sfu_available_track',
        publisherId,
        tracks: [
          { trackId: `audio-${publisherId}`, kind: 'audio' },
          { trackId: `video-${publisherId}`, kind: 'video' }
        ]
      });
    }
  }

  console.log(`[Signaling] ${client.displayName}(${clientId}) 加入房间 ${roomId}`);
}

function handleLeave(ws, msg) {
  const clientId = ws.clientId;
  if (!clientId) return;

  const client = clients.get(clientId);
  if (!client) return;

  const { roomId } = client;

  roomManager.leaveRoom(roomId, clientId);
  sfu.unregisterClient(clientId);

  roomManager.broadcastToRoom(roomId, {
    type: 'peer_left',
    clientId,
    displayName: client.displayName,
    timestamp: Date.now()
  });

  clients.delete(clientId);
  ws.clientInfo = null;

  console.log(`[Signaling] 客户端 ${clientId} 离开房间 ${roomId}`);
}

function handleOffer(ws, msg) {
  const { to, sdp } = msg;
  const from = ws.clientId;
  if (!to || !sdp) {
    sendError(ws, 'INVALID_PARAMS', 'offer 需要 to 和 sdp');
    return;
  }

  let realTo = to;
  if (to.endsWith('_send')) {
    realTo = to.slice(0, -5);
  } else if (to.endsWith('_recv')) {
    realTo = to.slice(0, -5);
  }

  const target = clients.get(realTo);
  if (!target) {
    sendError(ws, 'PEER_NOT_FOUND', `目标客户端 ${to} 不存在`);
    return;
  }

  send(target.ws, {
    type: 'offer',
    from,
    to,
    sdp,
    timestamp: Date.now()
  });
}

function handleAnswer(ws, msg) {
  const { to, sdp } = msg;
  const from = ws.clientId;
  if (!to || !sdp) {
    sendError(ws, 'INVALID_PARAMS', 'answer 需要 to 和 sdp');
    return;
  }

  let realTo = to;
  if (to.endsWith('_send')) {
    realTo = to.slice(0, -5);
  } else if (to.endsWith('_recv')) {
    realTo = to.slice(0, -5);
  }

  const target = clients.get(realTo);
  if (!target) {
    sendError(ws, 'PEER_NOT_FOUND', `目标客户端 ${to} 不存在`);
    return;
  }

  send(target.ws, {
    type: 'answer',
    from,
    to,
    sdp,
    timestamp: Date.now()
  });
}

function handleIceCandidate(ws, msg) {
  const { to, candidate } = msg;
  const from = ws.clientId;
  if (!to || !candidate) {
    sendError(ws, 'INVALID_PARAMS', 'ice_candidate 需要 to 和 candidate');
    return;
  }

  let realTo = to;
  if (to.endsWith('_send')) {
    realTo = to.slice(0, -5);
  } else if (to.endsWith('_recv')) {
    realTo = to.slice(0, -5);
  }

  const target = clients.get(realTo);
  if (!target) {
    sendError(ws, 'PEER_NOT_FOUND', `目标客户端 ${to} 不存在`);
    return;
  }

  send(target.ws, {
    type: 'ice_candidate',
    from,
    to,
    candidate,
    timestamp: Date.now()
  });
}

function handleSfuPublish(ws, msg) {
  const clientId = ws.clientId;
  const { tracks } = msg;
  const client = clients.get(clientId);

  if (!client) return;

  if (tracks && Array.isArray(tracks)) {
    tracks.forEach(t => {
      client.publishedTracks.add(t.trackId);
    });
  }

  const others = roomManager.getOtherClients(client.roomId, clientId);
  others.forEach(other => {
    if (tracks && Array.isArray(tracks)) {
      tracks.forEach(t => {
        sfu.addRoute(clientId, other.id, t.trackId, t.kind);
      });
    }
    send(other.ws, {
      type: 'sfu_available_track',
      publisherId: clientId,
      tracks: tracks || []
    });
  });

  send(ws, {
    type: 'sfu_publish_ok',
    tracks: Array.from(client.publishedTracks)
  });
}

function handleSfuUnpublish(ws, msg) {
  const clientId = ws.clientId;
  const { tracks } = msg;
  const client = clients.get(clientId);
  if (!client) return;

  if (tracks && Array.isArray(tracks)) {
    tracks.forEach(trackId => {
      client.publishedTracks.delete(trackId);
      const others = roomManager.getOtherClients(client.roomId, clientId);
      others.forEach(other => {
        sfu.removeRoute(clientId, other.id, trackId);
        send(other.ws, {
          type: 'sfu_track_removed',
          publisherId: clientId,
          trackId
        });
      });
    });
  }

  send(ws, {
    type: 'sfu_unpublish_ok'
  });
}

function handleSfuSubscribe(ws, msg) {
  const clientId = ws.clientId;
  const { publisherId, trackId, kind } = msg;

  if (!publisherId || !trackId) {
    sendError(ws, 'INVALID_PARAMS', 'subscribe 需要 publisherId 和 trackId');
    return;
  }

  sfu.addRoute(publisherId, clientId, trackId, kind || 'video');
  const client = clients.get(clientId);
  if (client) {
    client.subscribedTo.add(`${publisherId}:${trackId}`);
  }

  send(ws, {
    type: 'sfu_subscribe_ok',
    publisherId,
    trackId,
    kind
  });
}

function handleSfuUnsubscribe(ws, msg) {
  const clientId = ws.clientId;
  const { publisherId, trackId } = msg;

  sfu.removeRoute(publisherId, clientId, trackId);
  const client = clients.get(clientId);
  if (client) {
    client.subscribedTo.delete(`${publisherId}:${trackId}`);
  }

  send(ws, {
    type: 'sfu_unsubscribe_ok',
    publisherId,
    trackId
  });
}

function handleSfuMediaPacketIn(ws, msg) {
  const clientId = ws.clientId;
  const { trackId, data, kind } = msg;

  if (!trackId || data === undefined) return;

  const packet = typeof data === 'string'
    ? (data.length > 0 ? Buffer.from(data, 'base64') : data)
    : data;

  const forwarded = sfu.forwardPacket(clientId, trackId, packet);
}

function handleChat(ws, msg) {
  const clientId = ws.clientId;
  const client = clients.get(clientId);
  if (!client) return;

  const { text } = msg;
  roomManager.broadcastToRoom(client.roomId, {
    type: 'chat',
    from: clientId,
    displayName: client.displayName,
    text,
    timestamp: Date.now()
  });
}

function handleGetRoomInfo(ws, msg) {
  const client = clients.get(ws.clientId);
  if (!client) return;

  const { roomId } = client;
  const ids = roomManager.getClientIds(roomId);
  const peers = ids.map(id => {
    const c = clients.get(id);
    return c ? {
      clientId: id,
      displayName: c.displayName,
      publishedTracks: Array.from(c.publishedTracks),
      joinedAt: c.joinedAt
    } : { clientId: id };
  });

  send(ws, {
    type: 'room_info',
    roomId,
    peers,
    sfuStats: sfu.getStats()
  });
}

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws, code, message) {
  send(ws, { type: 'error', code, message, timestamp: Date.now() });
}

wss.on('connection', (ws, req) => {
  console.log(`[Signaling] 新 WebSocket 连接: ${req.socket.remoteAddress}`);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => handleMessage(ws, data));

  ws.on('close', (code, reason) => {
    const clientId = ws.clientId;
    if (!clientId) return;

    const client = clients.get(clientId);
    if (client) {
      const { roomId } = client;

      roomManager.leaveRoom(roomId, clientId);
      sfu.unregisterClient(clientId);

      roomManager.broadcastToRoom(roomId, {
        type: 'peer_left',
        clientId,
        displayName: client.displayName,
        reason: 'disconnect',
        timestamp: Date.now()
      });

      clients.delete(clientId);
      console.log(`[Signaling] 连接关闭: ${clientId}, code=${code}`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[Signaling] WebSocket 错误:`, err.message);
  });
});

const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      const clientId = ws.clientId;
      if (clientId) {
        const client = clients.get(clientId);
        if (client) {
          roomManager.leaveRoom(client.roomId, clientId);
          sfu.unregisterClient(clientId);
          roomManager.broadcastToRoom(client.roomId, {
            type: 'peer_left',
            clientId,
            displayName: client.displayName,
            reason: 'timeout',
            timestamp: Date.now()
          });
          clients.delete(clientId);
        }
      }
      return ws.terminate();
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log('  WebRTC 信令服务器 + SFU 雏形');
  console.log('========================================');
  console.log(`  HTTP 服务端口: ${PORT}`);
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log('========================================');
  console.log('  信令消息类型:');
  console.log('  - join / leave: 房间管理');
  console.log('  - offer / answer: SDP 交换');
  console.log('  - ice_candidate: ICE 候选交换');
  console.log('  - sfu_publish / sfu_subscribe: SFU 发布订阅');
  console.log('  - sfu_media_packet_in / sfu_media_packet: 媒体数据转发');
  console.log('========================================');
});
