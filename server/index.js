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

sfu.on('packet', ({ receiverId, senderId, trackId, kind, packet, seq }) => {
  const client = clients.get(receiverId);
  if (client && client.ws && client.ws.readyState === WebSocket.OPEN) {
    try {
      client.ws.send(JSON.stringify({
        type: 'sfu_media_packet',
        from: senderId,
        trackId,
        kind,
        seq,
        size: packet.length || (typeof packet === 'string' ? packet.length : JSON.stringify(packet).length),
        ts: Date.now()
      }));
    } catch (e) {
      console.error(`[SFU] 发送媒体包到 ${receiverId} 失败:`, e.message);
    }
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
    case 'sfu_request_full_sync':
      handleSfuRequestFullSync(ws, msg);
      break;
    case 'connection_state':
      handleConnectionState(ws, msg);
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
  const { roomId, displayName, mode } = msg;
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
    mode: mode || 'sfu',
    displayName: displayName || `用户-${clientId.slice(0, 4)}`,
    joinedAt: Date.now(),
    publishedTracks: new Set(),
    subscribedTo: new Set(),
    connectionStates: new Map()
  };

  clients.set(clientId, client);
  ws.clientInfo = client;

  const existingClientIds = roomManager.getClientIds(roomId);
  const room = roomManager.joinRoom(roomId, client);

  sfu.registerClient(clientId, roomId);

  const peerDetails = existingClientIds.map(id => {
    const c = clients.get(id);
    return {
      clientId: id,
      displayName: c ? c.displayName : id,
      publishedTracks: c ? Array.from(c.publishedTracks) : []
    };
  });

  send(ws, {
    type: 'joined',
    clientId,
    roomId,
    mode: client.mode,
    displayName: client.displayName,
    peers: peerDetails,
    timestamp: Date.now()
  });

  roomManager.broadcastToRoom(roomId, {
    type: 'peer_joined',
    clientId,
    displayName: client.displayName,
    mode: client.mode,
    timestamp: Date.now()
  }, clientId);

  if (existingClientIds.length > 0 && client.mode === 'sfu') {
    const addedRoutes = sfu.setupFullMeshRoutes(roomId, existingClientIds, clientId);

    send(ws, {
      type: 'sfu_route_info',
      roomId,
      routes: {
        incomingPublishers: existingClientIds,
        outgoingSubscribers: existingClientIds,
        totalRoutesAdded: addedRoutes.length
      }
    });

    for (const publisherId of existingClientIds) {
      const publisherClient = clients.get(publisherId);
      const tracks = publisherClient
        ? Array.from(publisherClient.publishedTracks).map(tid => {
            const kind = tid.startsWith('audio') ? 'audio' : 'video';
            return { trackId: tid, kind };
          })
        : [
            { trackId: `audio-${publisherId}`, kind: 'audio' },
            { trackId: `video-${publisherId}`, kind: 'video' }
          ];

      send(ws, {
        type: 'sfu_available_track',
        publisherId,
        tracks
      });

      client.subscribedTo.add(`${publisherId}:audio-${publisherId}`);
      client.subscribedTo.add(`${publisherId}:video-${publisherId}`);
    }
  }

  setTimeout(() => {
    roomManager.broadcastToRoom(roomId, {
      type: 'sfu_request_full_sync',
      from: clientId,
      timestamp: Date.now()
    });
  }, 300);

  console.log(`[Signaling] ${client.displayName}(${clientId}) 加入房间 ${roomId} [模式=${client.mode}]`);
}

function handleLeave(ws, msg) {
  const clientId = ws.clientId;
  if (!clientId) return;

  const client = clients.get(clientId);
  if (!client) return;

  const { roomId, displayName } = client;

  cleanupClient(clientId, roomId, displayName, 'leave');

  clients.delete(clientId);
  if (ws.clientInfo) ws.clientInfo = null;

  console.log(`[Signaling] 客户端 ${clientId} 主动离开房间 ${roomId}`);
}

function cleanupClient(clientId, roomId, displayName, reason) {
  roomManager.leaveRoom(roomId, clientId);
  sfu.unregisterClient(clientId);

  roomManager.broadcastToRoom(roomId, {
    type: 'peer_left',
    clientId,
    displayName,
    reason,
    sfuStats: sfu.getStats(),
    timestamp: Date.now()
  });

  for (const [otherId, other] of clients) {
    if (other.roomId === roomId && other.connectionStates) {
      other.connectionStates.delete(clientId);
    }
  }
}

function handleOffer(ws, msg) {
  const { to, sdp } = msg;
  const from = ws.clientId;
  if (!to || !sdp) {
    sendError(ws, 'INVALID_PARAMS', 'offer 需要 to 和 sdp');
    return;
  }

  const target = clients.get(to);
  if (!target) {
    sendError(ws, 'PEER_NOT_FOUND', `目标客户端 ${to} 不存在`);
    return;
  }

  send(target.ws, {
    type: 'offer',
    from,
    sdp,
    timestamp: Date.now()
  });

  console.log(`[Signaling] Offer: ${from} → ${to}`);
}

function handleAnswer(ws, msg) {
  const { to, sdp } = msg;
  const from = ws.clientId;
  if (!to || !sdp) {
    sendError(ws, 'INVALID_PARAMS', 'answer 需要 to 和 sdp');
    return;
  }

  const target = clients.get(to);
  if (!target) {
    sendError(ws, 'PEER_NOT_FOUND', `目标客户端 ${to} 不存在`);
    return;
  }

  send(target.ws, {
    type: 'answer',
    from,
    sdp,
    timestamp: Date.now()
  });

  console.log(`[Signaling] Answer: ${from} → ${to}`);
}

function handleIceCandidate(ws, msg) {
  const { to, candidate } = msg;
  const from = ws.clientId;
  if (!to || !candidate) {
    sendError(ws, 'INVALID_PARAMS', 'ice_candidate 需要 to 和 candidate');
    return;
  }

  const target = clients.get(to);
  if (!target) {
    sendError(ws, 'PEER_NOT_FOUND', `目标客户端 ${to} 不存在`);
    return;
  }

  send(target.ws, {
    type: 'ice_candidate',
    from,
    candidate,
    timestamp: Date.now()
  });
}

function handleConnectionState(ws, msg) {
  const clientId = ws.clientId;
  const client = clients.get(clientId);
  if (!client) return;

  const { peerId, state } = msg;
  client.connectionStates.set(peerId, state);

  const target = clients.get(peerId);
  if (target) {
    send(target.ws, {
      type: 'connection_state',
      from: clientId,
      state,
      timestamp: Date.now()
    });
  }
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
    tracks: Array.from(client.publishedTracks),
    sfuStats: sfu.getStats()
  });

  console.log(`[SFU] ${clientId} 发布了 ${tracks ? tracks.length : 0} 条轨道`);
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
          trackId,
          sfuStats: sfu.getStats()
        });
      });
    });
  }

  send(ws, {
    type: 'sfu_unpublish_ok',
    sfuStats: sfu.getStats()
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
    kind,
    sfuStats: sfu.getStats()
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
    trackId,
    sfuStats: sfu.getStats()
  });
}

function handleSfuMediaPacketIn(ws, msg) {
  const clientId = ws.clientId;
  const { trackId, kind, seq, count } = msg;

  if (!trackId) return;

  let forwardedTotal = 0;
  let seqNum = seq || 1;
  const packetCount = count || 1;

  for (let i = 0; i < packetCount; i++) {
    const currentSeq = seqNum + i;
    const mockPacket = Buffer.from(`sfu_packet_${clientId}_${trackId}_${currentSeq}_${Date.now()}`);
    const forwarded = sfu.forwardPacket(clientId, trackId, mockPacket, currentSeq);
    forwardedTotal += forwarded;
  }

  send(ws, {
    type: 'sfu_media_ack',
    trackId,
    seq: seqNum,
    count: packetCount,
    forwardedTo: forwardedTotal,
    sfuStats: sfu.getStats(),
    timestamp: Date.now()
  });

  const others = roomManager.getOtherClients(ws.clientInfo ? ws.clientInfo.roomId : '', clientId);
  others.forEach(other => {
    send(other.ws, {
      type: 'sfu_media_stats_update',
      publisherId: clientId,
      trackId,
      lastSeq: seqNum + packetCount - 1,
      sfuStats: sfu.getStats(),
      timestamp: Date.now()
    });
  });
}

function handleSfuRequestFullSync(ws, msg) {
  const from = msg.from;
  const clientId = ws.clientId;
  const client = clients.get(clientId);
  if (!client) return;

  if (from !== clientId && client.publishedTracks.size > 0) {
    send(clients.get(from).ws, {
      type: 'sfu_available_track',
      publisherId: clientId,
      tracks: Array.from(client.publishedTracks).map(tid => ({
        trackId: tid,
        kind: tid.startsWith('audio') ? 'audio' : 'video'
      }))
    });
    console.log(`[SFU] 同步 ${clientId} 的轨道给 ${from}`);
  }
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

  const { roomId, mode } = client;
  const ids = roomManager.getClientIds(roomId);
  const peers = ids.map(id => {
    const c = clients.get(id);
    return c ? {
      clientId: id,
      displayName: c.displayName,
      publishedTracks: Array.from(c.publishedTracks),
      subscribedTo: Array.from(c.subscribedTo),
      joinedAt: c.joinedAt,
      connectionStates: c.connectionStates ? Object.fromEntries(c.connectionStates) : {}
    } : { clientId: id };
  });

  send(ws, {
    type: 'room_info',
    roomId,
    mode,
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
      const { roomId, displayName } = client;
      cleanupClient(clientId, roomId, displayName, 'disconnect');
      clients.delete(clientId);
      console.log(`[Signaling] 连接关闭: ${clientId}, code=${code}, room=${roomId}`);
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
          const { roomId, displayName } = client;
          cleanupClient(clientId, roomId, displayName, 'timeout');
          clients.delete(clientId);
          console.log(`[Signaling] 客户端超时: ${clientId}`);
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
  console.log('  WebRTC 信令服务器 + SFU 雏形 v2');
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
  console.log('  - sfu_media_packet_in: 模拟媒体包→SFU转发');
  console.log('  - connection_state: 同步连接状态');
  console.log('========================================');
});
