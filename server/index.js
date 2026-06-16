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
const pendingReconnect = new Map();
const RECONNECT_WINDOW_MS = 10000;

sfu.on('packet', ({ receiverId, senderId, trackId, kind, packet, seq, totalForRoute }) => {
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
        ts: Date.now(),
        totalForRoute
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
    case 'ice_state':
      handleIceState(ws, msg);
      break;
    case 'track_count':
      handleTrackCount(ws, msg);
      break;
    case 'owner_kick':
      handleOwnerKick(ws, msg);
      break;
    case 'owner_resync_all':
      handleOwnerResyncAll(ws, msg);
      break;
    case 'owner_transfer':
      handleOwnerTransfer(ws, msg);
      break;
    case 'owner_force_reconnect':
      handleOwnerForceReconnect(ws, msg);
      break;
    case 'owner_rebuild_subscription':
      handleOwnerRebuildSubscription(ws, msg);
      break;
    case 'owner_clear_peer_state':
      handleOwnerClearPeerState(ws, msg);
      break;
    case 'reconnect_ack':
      handleReconnectAck(ws, msg);
      break;
    default:
      console.warn(`[Signaling] 未知消息类型: ${type} 来自 ${clientId}`);
      sendError(ws, 'UNKNOWN_TYPE', `未知消息类型: ${type}`);
  }
}

function handleJoin(ws, msg) {
  const { roomId, displayName, mode, reconnectClientId } = msg;
  if (!roomId) {
    sendError(ws, 'MISSING_ROOM_ID', '缺少 roomId');
    return;
  }

  let clientId;
  let isReconnect = false;
  let existingClient = null;

  if (reconnectClientId && pendingReconnect.has(reconnectClientId)) {
    const pending = pendingReconnect.get(reconnectClientId);
    if (pending.roomId === roomId && pending.displayName === displayName) {
      clientId = reconnectClientId;
      isReconnect = true;
      existingClient = pending.clientData;
      pendingReconnect.delete(reconnectClientId);
      console.log(`[Signaling] 客户端重连: ${clientId}`);
    }
  }

  if (!clientId) {
    clientId = uuidv4().slice(0, 12);
  }

  ws.clientId = clientId;

  const client = existingClient || {
    id: clientId,
    ws,
    roomId,
    mode: mode || 'sfu',
    displayName: displayName || `用户-${clientId.slice(0, 4)}`,
    joinedAt: Date.now(),
    lastSignalingAt: Date.now(),
    publishedTracks: new Set(),
    subscribedTo: new Set(),
    connectionStates: new Map(),
    iceStates: new Map(),
    trackCount: { audio: 0, video: 0, total: 0 },
    recentEvents: [],
    sfuMediaStats: {
      sentPackets: 0,
      sentBytes: 0,
      receivedPackets: 0,
      receivedBytes: 0,
      lastSentAt: null,
      lastReceivedAt: null,
      perPublisherStats: new Map(),
      perReceiverStats: new Map()
    }
  };

  client.ws = ws;
  client.lastSignalingAt = Date.now();

  clients.set(clientId, client);
  ws.clientInfo = client;

  const existingClientIds = roomManager.getClientIds(roomId);
  const room = roomManager.joinRoom(roomId, client);
  const ownerId = roomManager.getOwner(roomId);

  if (!isReconnect) {
    sfu.registerClient(clientId, roomId);
  }

  const peerDetails = existingClientIds
    .filter(id => id !== clientId)
    .map(id => {
      const c = clients.get(id);
      return {
        clientId: id,
        displayName: c ? c.displayName : id,
        publishedTracks: c ? Array.from(c.publishedTracks) : [],
        isOwner: id === ownerId,
        connectionStates: c ? Object.fromEntries(c.connectionStates) : {},
        lastSignalingAt: c ? c.lastSignalingAt : null,
        trackCount: c ? c.trackCount : { audio: 0, video: 0, total: 0 }
      };
    });

  send(ws, {
    type: 'joined',
    clientId,
    roomId,
    mode: client.mode,
    displayName: client.displayName,
    isOwner: ownerId === clientId,
    ownerId,
    isReconnect,
    peers: peerDetails,
    sfuStats: sfu.getStats(),
    sfuPerClientStats: sfu.getPerClientStats(),
    timestamp: Date.now()
  });

  if (ownerId === clientId && existingClientIds.length > 0) {
    roomManager.broadcastToRoom(roomId, {
      type: 'owner_changed',
      newOwnerId: clientId,
      newOwnerName: client.displayName,
      timestamp: Date.now()
    });
  }

  roomManager.addRoomEvent(roomId, isReconnect ? 'peer_reconnect' : 'peer_joined', {
    clientId,
    displayName: client.displayName,
    mode: client.mode,
    isOwner: ownerId === clientId
  }, generateRoomSnapshot(roomId));

  roomManager.broadcastToRoom(roomId, {
    type: 'peer_joined',
    clientId,
    displayName: client.displayName,
    mode: client.mode,
    isOwner: ownerId === clientId,
    isReconnect,
    timestamp: Date.now()
  }, clientId);

  if (existingClientIds.length > 0 && client.mode === 'sfu') {
    const addedRoutes = isReconnect ? [] : sfu.setupFullMeshRoutes(roomId, existingClientIds, clientId);

    send(ws, {
      type: 'sfu_route_info',
      roomId,
      routes: {
        incomingPublishers: existingClientIds,
        outgoingSubscribers: existingClientIds,
        totalRoutesAdded: isReconnect ? 'reused' : addedRoutes.length
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

  addClientEvent(clientId, isReconnect ? 'reconnect' : 'join', { 
    roomId, 
    mode: client.mode, 
    isOwner: ownerId === clientId 
  });

  console.log(`[Signaling] ${client.displayName}(${clientId}) ${isReconnect ? '重连' : '加入'} 房间 ${roomId} [模式=${client.mode}, 房主=${ownerId === clientId}]`);
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

function cleanupClient(clientId, roomId, displayName, reason, delay = false) {
  if (delay) {
    const client = clients.get(clientId);
    if (!client) return;

    const clientData = { ...client };
    clientData.ws = null;
    pendingReconnect.set(clientId, {
      roomId,
      displayName,
      clientData,
      createdAt: Date.now()
    });

    setTimeout(() => {
      if (pendingReconnect.has(clientId)) {
        pendingReconnect.delete(clientId);
        performCleanup(clientId, roomId, displayName, reason);
      }
    }, RECONNECT_WINDOW_MS);

    console.log(`[Signaling] 延迟清理 ${clientId}, 等待重连窗口 ${RECONNECT_WINDOW_MS}ms`);
    return;
  }

  performCleanup(clientId, roomId, displayName, reason);
}

function performCleanup(clientId, roomId, displayName, reason) {
  const oldOwnerId = roomManager.getOwner(roomId);
  roomManager.leaveRoom(roomId, clientId);
  sfu.unregisterClient(clientId);
  const newOwnerId = roomManager.getOwner(roomId);

  roomManager.addRoomEvent(roomId, 'peer_left', {
    clientId,
    displayName,
    reason,
    newOwnerId: oldOwnerId === clientId ? newOwnerId : null,
    newOwnerName: oldOwnerId === clientId
      ? (clients.get(newOwnerId) ? clients.get(newOwnerId).displayName : null)
      : null
  }, generateRoomSnapshot(roomId));

  roomManager.broadcastToRoom(roomId, {
    type: 'peer_left',
    clientId,
    displayName,
    reason,
    sfuStats: sfu.getStats(),
    sfuPerClientStats: sfu.getPerClientStats(),
    newOwnerId: oldOwnerId === clientId ? newOwnerId : null,
    newOwnerName: oldOwnerId === clientId
      ? (clients.get(newOwnerId) ? clients.get(newOwnerId).displayName : null)
      : null,
    timestamp: Date.now()
  });

  if (oldOwnerId === clientId && newOwnerId && newOwnerId !== clientId) {
    roomManager.broadcastToRoom(roomId, {
      type: 'owner_changed',
      newOwnerId,
      newOwnerName: clients.get(newOwnerId) ? clients.get(newOwnerId).displayName : null,
      reason: 'previous_owner_left',
      timestamp: Date.now()
    });
  }

  for (const [otherId, other] of clients) {
    if (other.roomId === roomId && other.connectionStates) {
      other.connectionStates.delete(clientId);
    }
    if (other.roomId === roomId && other.iceStates) {
      other.iceStates.delete(clientId);
    }
  }

  if (clients.has(clientId)) {
    clients.delete(clientId);
  }

  console.log(`[Signaling] 完成清理客户端 ${clientId}, 原房主=${oldOwnerId}, 新房主=${newOwnerId}`);
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

  const client = clients.get(from);
  if (client) addClientEvent(from, 'offer', { to });
  if (target) addClientEvent(to, 'offer_received', { from });

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

  const client = clients.get(from);
  if (client) addClientEvent(from, 'answer', { to });
  if (target) addClientEvent(to, 'answer_received', { from });

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

  const client = clients.get(from);
  if (client) client.lastSignalingAt = Date.now();
}

function handleConnectionState(ws, msg) {
  const clientId = ws.clientId;
  const client = clients.get(clientId);
  if (!client) return;

  const { peerId, state } = msg;
  client.connectionStates.set(peerId, state);

  addClientEvent(clientId, 'connection_state', { peerId, state });

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

  addClientEvent(clientId, 'sfu_publish', { trackCount: tracks ? tracks.length : 0 });

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

  addClientEvent(clientId, 'sfu_subscribe', { publisherId, trackId, kind });
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
  const client = clients.get(clientId);
  if (!client) return;

  const { trackId, kind, seq, count } = msg;
  if (!trackId) return;

  let seqNum = seq || 1;
  const packetCount = count || 1;
  const allReceiverDetails = [];
  const perReceiverCounts = new Map();

  for (let i = 0; i < packetCount; i++) {
    const currentSeq = seqNum + i;
    const mockPacket = Buffer.from(`sfu_packet_${clientId}_${trackId}_${currentSeq}_${Date.now()}`);
    const result = sfu.forwardPacket(clientId, trackId, mockPacket, currentSeq);

    result.receiverDetails.forEach(detail => {
      if (!perReceiverCounts.has(detail.receiverId)) {
        perReceiverCounts.set(detail.receiverId, {
          receiverId: detail.receiverId,
          count: 0,
          totalPackets: 0,
          totalBytes: 0,
          kind: detail.kind
        });
      }
      const entry = perReceiverCounts.get(detail.receiverId);
      entry.count++;
      entry.totalPackets = detail.packetsForThisRoute;
      entry.totalBytes = detail.bytesForThisRoute;
      allReceiverDetails.push(detail);
    });
  }

  const receiverSummary = Array.from(perReceiverCounts.values());
  const totalPacketsSent = packetCount;
  const totalReceivers = receiverSummary.length;
  const totalForwardedPackets = totalPacketsSent * totalReceivers;

  if (client.sfuMediaStats) {
    client.sfuMediaStats.sentPackets += totalForwardedPackets;
    client.sfuMediaStats.sentBytes += totalForwardedPackets * 64;
    client.sfuMediaStats.lastSentAt = Date.now();
    receiverSummary.forEach(r => {
      const key = `${r.receiverId}:${trackId}`;
      client.sfuMediaStats.perReceiverStats.set(key, {
        receiverId: r.receiverId,
        trackId,
        kind: r.kind,
        packets: r.totalPackets,
        bytes: r.totalBytes,
        lastSentAt: Date.now()
      });
    });
  }

  send(ws, {
    type: 'sfu_media_ack',
    trackId,
    kind,
    seqStart: seqNum,
    seqEnd: seqNum + packetCount - 1,
    packetsSent: totalPacketsSent,
    totalReceivers,
    totalForwardedPackets,
    receiverSummary,
    sfuStats: sfu.getStats(),
    sfuPerClientStats: sfu.getPerClientStats(),
    timestamp: Date.now()
  });

  const others = roomManager.getOtherClients(client.roomId, clientId);
  others.forEach(other => {
    send(other.ws, {
      type: 'sfu_media_stats_update',
      publisherId: clientId,
      publisherName: client.displayName,
      trackId,
      kind,
      lastSeq: seqNum + packetCount - 1,
      packetsReceived: packetCount,
      totalForThisPublisher: perReceiverCounts.get(other.id)
        ? perReceiverCounts.get(other.id).totalPackets
        : 0,
      sfuStats: sfu.getStats(),
      sfuPerClientStats: sfu.getPerClientStats(),
      timestamp: Date.now()
    });

    if (other.sfuMediaStats) {
      const key = `${clientId}:${trackId}`;
      const stats = other.sfuMediaStats;
      stats.receivedPackets += packetCount;
      stats.receivedBytes += packetCount * 64;
      stats.lastReceivedAt = Date.now();
      stats.perPublisherStats.set(key, {
        publisherId: clientId,
        trackId,
        kind,
        packets: perReceiverCounts.get(other.id) ? perReceiverCounts.get(other.id).totalPackets : 0,
        bytes: perReceiverCounts.get(other.id) ? perReceiverCounts.get(other.id).totalBytes : 0,
        lastReceivedAt: Date.now()
      });
    }
  });

  addClientEvent(clientId, 'sfu_media_packet', { 
    packetCount, 
    totalReceivers, 
    totalForwardedPackets,
    trackId
  });

  roomManager.addRoomEvent(client.roomId, 'sfu_media_forward', {
    senderId: clientId,
    senderName: client.displayName,
    packetCount,
    totalReceivers,
    totalForwardedPackets,
    trackId
  });

  console.log(`[SFU] ${clientId} 发送 ${packetCount} 个包 → 转发给 ${totalReceivers} 人, 共 ${totalForwardedPackets} 次转发`);
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
  addClientEvent(clientId, 'chat', { textLength: text.length });
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
  const ownerId = roomManager.getOwner(roomId);
  const ids = roomManager.getClientIds(roomId);
  const sfuPerClient = sfu.getPerClientStats();
  const now = Date.now();

  addClientEvent(ws.clientId, 'get_room_info', { manual: true });

  const peers = ids.map(id => {
    const c = clients.get(id);
    if (!c) return { clientId: id };

    const sfuStats = sfuPerClient[id] || {
      sentPackets: 0,
      sentBytes: 0,
      receivedPackets: 0,
      receivedBytes: 0,
      routesAsSender: 0,
      routesAsReceiver: 0
    };

    return {
      clientId: id,
      displayName: c.displayName,
      isOwner: id === ownerId,
      publishedTracks: Array.from(c.publishedTracks),
      subscribedTo: Array.from(c.subscribedTo),
      joinedAt: c.joinedAt,
      lastSignalingAt: c.lastSignalingAt,
      connectionStates: c.connectionStates ? Object.fromEntries(c.connectionStates) : {},
      iceStates: c.iceStates ? Object.fromEntries(c.iceStates) : {},
      trackCount: c.trackCount || { audio: 0, video: 0, total: 0 },
      recentEvents: c.recentEvents || [],
      sfuMediaStats: {
        sentPackets: sfuStats.sentPackets,
        sentBytes: sfuStats.sentBytes,
        receivedPackets: sfuStats.receivedPackets,
        receivedBytes: sfuStats.receivedBytes,
        routesAsSender: sfuStats.routesAsSender,
        routesAsReceiver: sfuStats.routesAsReceiver,
        lastSentAt: c.sfuMediaStats ? c.sfuMediaStats.lastSentAt : null,
        lastReceivedAt: c.sfuMediaStats ? c.sfuMediaStats.lastReceivedAt : null,
        perReceiverBreakdown: sfuStats.perReceiverBreakdown || {},
        perPublisherBreakdown: sfuStats.perPublisherBreakdown || {}
      }
    };
  });

  const health = calculateRoomHealth(peers, roomManager.getRoomEvents(roomId), ids.length, now);

  send(ws, {
    type: 'room_info',
    roomId,
    mode,
    ownerId,
    isOwner: ownerId === client.id,
    peers,
    sfuStats: sfu.getStats(),
    sfuPerClientStats: sfuPerClient,
    roomEvents: roomManager.getRoomEvents(roomId),
    health,
    timestamp: now
  });
}

function calculateRoomHealth(peers, events, totalPeers, now) {
  const alerts = [];
  let score = 100;

  let disconnectedCount = 0;
  let iceFailedCount = 0;
  let noMediaCount = 0;
  let recentReconnectCount = 0;
  let staleSignalingCount = 0;

  peers.forEach(peer => {
    const connStates = peer.connectionStates || {};
    const iceStates = peer.iceStates || {};
    
    Object.values(connStates).forEach(state => {
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        disconnectedCount++;
      }
    });

    Object.values(iceStates).forEach(state => {
      if (state === 'failed' || state === 'disconnected') {
        iceFailedCount++;
      }
    });

    if (peer.sfuMediaStats) {
      const lastReceived = peer.sfuMediaStats.lastReceivedAt;
      const lastSent = peer.sfuMediaStats.lastSentAt;
      if ((!lastReceived || now - lastReceived > 60000) && 
          (!lastSent || now - lastSent > 60000) &&
          totalPeers > 1) {
        noMediaCount++;
      }
    }

    const lastSig = peer.lastSignalingAt;
    if (lastSig && now - lastSig > 120000) {
      staleSignalingCount++;
    }
  });

  const fiveMinutesAgo = now - 300000;
  recentReconnectCount = events.filter(e => 
    (e.type === 'peer_reconnect' || e.type === 'reconnect') && 
    e.timestamp > fiveMinutesAgo
  ).length;

  if (disconnectedCount > 0) {
    score -= disconnectedCount * 15;
    alerts.push({
      level: 'error',
      code: 'DISCONNECTED_PEERS',
      message: `${disconnectedCount} 个连接已断开`,
      count: disconnectedCount
    });
  }

  if (iceFailedCount > 0) {
    score -= iceFailedCount * 10;
    alerts.push({
      level: 'error',
      code: 'ICE_FAILED',
      message: `${iceFailedCount} 个 ICE 连接失败`,
      count: iceFailedCount
    });
  }

  if (noMediaCount > 0 && totalPeers > 1) {
    score -= noMediaCount * 8;
    alerts.push({
      level: 'warning',
      code: 'NO_MEDIA_FLOW',
      message: `${noMediaCount} 个成员超过 60 秒无媒体包`,
      count: noMediaCount
    });
  }

  if (recentReconnectCount > 0) {
    score -= recentReconnectCount * 5;
    alerts.push({
      level: 'warning',
      code: 'FREQUENT_RECONNECT',
      message: `最近 5 分钟有 ${recentReconnectCount} 次重连`,
      count: recentReconnectCount
    });
  }

  if (staleSignalingCount > 0) {
    score -= staleSignalingCount * 3;
    alerts.push({
      level: 'info',
      code: 'STALE_SIGNALING',
      message: `${staleSignalingCount} 个成员超过 2 分钟无信令`,
      count: staleSignalingCount
    });
  }

  score = Math.max(0, Math.min(100, score));

  let status = 'healthy';
  if (score < 60) status = 'critical';
  else if (score < 80) status = 'warning';

  return {
    score,
    status,
    totalPeers,
    disconnectedCount,
    iceFailedCount,
    noMediaCount,
    recentReconnectCount,
    staleSignalingCount,
    alerts
  };
}

function handleIceState(ws, msg) {
  const clientId = ws.clientId;
  const client = clients.get(clientId);
  if (!client) return;

  const { peerId, state } = msg;
  if (client.iceStates) {
    client.iceStates.set(peerId, state);
  }

  addClientEvent(clientId, 'ice_state', { peerId, state });

  const target = clients.get(peerId);
  if (target) {
    send(target.ws, {
      type: 'ice_state',
      from: clientId,
      state,
      timestamp: Date.now()
    });
  }
}

function handleTrackCount(ws, msg) {
  const clientId = ws.clientId;
  const client = clients.get(clientId);
  if (!client) return;

  const { audio, video, total } = msg;
  client.trackCount = { audio, video, total };
  client.lastSignalingAt = Date.now();
}

function handleOwnerKick(ws, msg) {
  const clientId = ws.clientId;
  const client = clients.get(clientId);
  if (!client) return;

  const ownerId = roomManager.getOwner(client.roomId);
  if (ownerId !== clientId) {
    sendError(ws, 'NOT_OWNER', '只有房主可以执行此操作');
    return;
  }

  const { targetClientId, reason } = msg;
  const target = clients.get(targetClientId);
  if (!target || target.roomId !== client.roomId) {
    sendError(ws, 'TARGET_NOT_FOUND', '目标用户不在房间内');
    return;
  }

  console.log(`[Owner] ${client.displayName}(${clientId}) 踢出 ${target.displayName}(${targetClientId}), 原因: ${reason || '未说明'}`);

  roomManager.addRoomEvent(client.roomId, 'owner_kick', {
    by: clientId,
    byName: client.displayName,
    targetClientId,
    targetName: target.displayName,
    reason: reason || '房主移出'
  }, generateRoomSnapshot(client.roomId));

  send(target.ws, {
    type: 'kicked',
    by: clientId,
    byName: client.displayName,
    reason: reason || '房主移出',
    timestamp: Date.now()
  });

  setTimeout(() => {
    if (target.ws) {
      try { target.ws.close(); } catch (e) {}
    }
    performCleanup(targetClientId, target.roomId, target.displayName, 'kicked');
  }, 100);

  send(ws, {
    type: 'owner_kick_ok',
    targetClientId,
    targetName: target.displayName,
    timestamp: Date.now()
  });
}

function handleOwnerResyncAll(ws, msg) {
  const clientId = ws.clientId;
  const client = clients.get(clientId);
  if (!client) return;

  const ownerId = roomManager.getOwner(client.roomId);
  if (ownerId !== clientId) {
    sendError(ws, 'NOT_OWNER', '只有房主可以执行此操作');
    return;
  }

  console.log(`[Owner] ${client.displayName}(${clientId}) 请求全员重新同步连接`);

  roomManager.addRoomEvent(client.roomId, 'owner_resync_all', {
    by: clientId,
    byName: client.displayName
  }, generateRoomSnapshot(client.roomId));

  roomManager.broadcastToRoom(client.roomId, {
    type: 'owner_resync_all',
    by: clientId,
    byName: client.displayName,
    timestamp: Date.now()
  });

  send(ws, {
    type: 'owner_resync_all_ok',
    timestamp: Date.now()
  });
}

function handleOwnerTransfer(ws, msg) {
  const clientId = ws.clientId;
  const client = clients.get(clientId);
  if (!client) return;

  const ownerId = roomManager.getOwner(client.roomId);
  if (ownerId !== clientId) {
    sendError(ws, 'NOT_OWNER', '只有房主可以执行此操作');
    return;
  }

  const { newOwnerId } = msg;
  const newOwner = clients.get(newOwnerId);
  if (!newOwner || newOwner.roomId !== client.roomId) {
    sendError(ws, 'TARGET_NOT_FOUND', '目标用户不在房间内');
    return;
  }

  roomManager.setOwner(client.roomId, newOwnerId);

  roomManager.addRoomEvent(client.roomId, 'owner_transfer', {
    previousOwnerId: clientId,
    previousOwnerName: client.displayName,
    newOwnerId,
    newOwnerName: newOwner.displayName
  }, generateRoomSnapshot(client.roomId));

  roomManager.broadcastToRoom(client.roomId, {
    type: 'owner_changed',
    newOwnerId,
    newOwnerName: newOwner.displayName,
    previousOwnerId: clientId,
    previousOwnerName: client.displayName,
    reason: 'transfer',
    timestamp: Date.now()
  });

  send(ws, {
    type: 'owner_transfer_ok',
    newOwnerId,
    newOwnerName: newOwner.displayName,
    timestamp: Date.now()
  });

  console.log(`[Owner] ${client.displayName} 将房主转让给 ${newOwner.displayName}`);
}

function handleOwnerForceReconnect(ws, msg) {
  const clientId = ws.clientId;
  const client = clients.get(clientId);
  if (!client || !client.roomId) {
    sendError(ws, 'NOT_IN_ROOM', '你不在房间中');
    return;
  }

  const ownerId = roomManager.getOwner(client.roomId);
  if (ownerId !== clientId) {
    sendError(ws, 'NOT_OWNER', '只有房主可以执行此操作');
    return;
  }

  const { targetClientId, reason } = msg;
  const target = clients.get(targetClientId);
  if (!target) {
    sendError(ws, 'CLIENT_NOT_FOUND', '目标客户端不存在');
    return;
  }

  roomManager.addRoomEvent(client.roomId, 'owner_force_reconnect', {
    by: clientId,
    byName: client.displayName,
    targetClientId,
    targetName: target.displayName,
    reason: reason || '房主要求重连'
  }, generateRoomSnapshot(client.roomId));

  send(target.ws, {
    type: 'owner_force_reconnect',
    by: clientId,
    byName: client.displayName,
    reason: reason || '房主要求重连',
    timestamp: Date.now()
  });

  send(ws, {
    type: 'owner_force_reconnect_ok',
    targetClientId,
    targetName: target.displayName,
    timestamp: Date.now()
  });

  console.log(`[Owner] ${client.displayName}(${clientId}) 要求 ${target.displayName}(${targetClientId}) 重新连接`);
}

function handleOwnerRebuildSubscription(ws, msg) {
  const clientId = ws.clientId;
  const client = clients.get(clientId);
  if (!client || !client.roomId) {
    sendError(ws, 'NOT_IN_ROOM', '你不在房间中');
    return;
  }

  const ownerId = roomManager.getOwner(client.roomId);
  if (ownerId !== clientId) {
    sendError(ws, 'NOT_OWNER', '只有房主可以执行此操作');
    return;
  }

  const { targetClientId, publisherId, trackId } = msg;
  const target = clients.get(targetClientId);
  if (!target) {
    sendError(ws, 'CLIENT_NOT_FOUND', '目标客户端不存在');
    return;
  }

  const publisher = clients.get(publisherId);
  const trackDesc = publisher && trackId 
    ? `${publisher.displayName || publisherId} 的 ${trackId}`
    : '所有';

  roomManager.addRoomEvent(client.roomId, 'owner_rebuild_subscription', {
    by: clientId,
    byName: client.displayName,
    targetClientId,
    targetName: target.displayName,
    publisherId,
    trackId,
    trackDesc
  }, generateRoomSnapshot(client.roomId));

  send(target.ws, {
    type: 'owner_rebuild_subscription',
    by: clientId,
    byName: client.displayName,
    publisherId,
    trackId,
    timestamp: Date.now()
  });

  send(ws, {
    type: 'owner_rebuild_subscription_ok',
    targetClientId,
    targetName: target.displayName,
    timestamp: Date.now()
  });

  console.log(`[Owner] ${client.displayName} 要求 ${target.displayName} 重建订阅: ${trackDesc}`);
}

function handleOwnerClearPeerState(ws, msg) {
  const clientId = ws.clientId;
  const client = clients.get(clientId);
  if (!client || !client.roomId) {
    sendError(ws, 'NOT_IN_ROOM', '你不在房间中');
    return;
  }

  const ownerId = roomManager.getOwner(client.roomId);
  if (ownerId !== clientId) {
    sendError(ws, 'NOT_OWNER', '只有房主可以执行此操作');
    return;
  }

  const { targetClientId } = msg;
  const target = clients.get(targetClientId);
  if (!target) {
    sendError(ws, 'CLIENT_NOT_FOUND', '目标客户端不存在');
    return;
  }

  target.connectionStates.clear();
  target.iceStates.clear();
  target.recentEvents = [];

  roomManager.addRoomEvent(client.roomId, 'owner_clear_state', {
    by: clientId,
    byName: client.displayName,
    targetClientId,
    targetName: target.displayName
  }, generateRoomSnapshot(client.roomId));

  send(target.ws, {
    type: 'owner_clear_state',
    by: clientId,
    byName: client.displayName,
    timestamp: Date.now()
  });

  roomManager.broadcastToRoom(client.roomId, {
    type: 'peer_state_cleared',
    targetClientId,
    targetName: target.displayName,
    timestamp: Date.now()
  });

  send(ws, {
    type: 'owner_clear_state_ok',
    targetClientId,
    targetName: target.displayName,
    timestamp: Date.now()
  });

  console.log(`[Owner] ${client.displayName} 清空了 ${target.displayName} 的连接状态`);
}

function handleReconnectAck(ws, msg) {
  const clientId = ws.clientId;
  const client = clients.get(clientId);
  if (!client) return;
  client.lastSignalingAt = Date.now();
  send(ws, { type: 'reconnect_ack_ok', timestamp: Date.now() });
}

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws, code, message) {
  send(ws, { type: 'error', code, message, timestamp: Date.now() });
}

function addClientEvent(clientId, eventType, eventData = {}) {
  const client = clients.get(clientId);
  if (!client) return;

  const now = Date.now();
  const event = {
    type: eventType,
    timestamp: now,
    ...eventData
  };

  client.recentEvents = client.recentEvents || [];
  client.recentEvents.push(event);

  client.recentEvents = client.recentEvents.filter(e => now - e.timestamp < 60000);

  client.lastSignalingAt = now;
}

function pruneOldEvents() {
  const now = Date.now();
  for (const client of clients.values()) {
    if (client.recentEvents) {
      client.recentEvents = client.recentEvents.filter(e => now - e.timestamp < 60000);
    }
  }
}

function generateRoomSnapshot(roomId) {
  const ids = roomManager.getClientIds(roomId);
  const sfuPerClient = sfu.getPerClientStats();

  return {
    timestamp: Date.now(),
    peers: ids.map(id => {
      const c = clients.get(id);
      if (!c) return { clientId: id };
      return {
        clientId: id,
        displayName: c.displayName,
        isOwner: id === roomManager.getOwner(roomId),
        connectionStates: c.connectionStates ? Object.fromEntries(c.connectionStates) : {},
        iceStates: c.iceStates ? Object.fromEntries(c.iceStates) : {},
        trackCount: c.trackCount || { audio: 0, video: 0, total: 0 },
        lastSignalingAt: c.lastSignalingAt
      };
    }),
    sfuStats: sfu.getStats()
  };
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
      if (pendingReconnect.has(clientId)) {
        pendingReconnect.delete(clientId);
        performCleanup(clientId, roomId, displayName, 'disconnect');
      } else {
        cleanupClient(clientId, roomId, displayName, 'disconnect', true);
      }
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
          cleanupClient(clientId, roomId, displayName, 'timeout', true);
          console.log(`[Signaling] 客户端超时，延迟清理: ${clientId}`);
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
