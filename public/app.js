const state = {
  ws: null,
  clientId: null,
  roomId: null,
  mode: 'sfu',
  displayName: '',
  joined: false,
  isOwner: false,
  ownerId: null,
  localStream: null,
  audioEnabled: true,
  videoEnabled: true,
  peers: new Map(),
  sfuMediaSeq: 1,
  lastSfuStats: null,
  lastPerClientStats: null,
  isReconnecting: false,
  reconnectAttempts: 0,
  lastRoomInfo: null,
  roomEvents: [],
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
  });
});

function log(type, message) {
  const panel = document.getElementById('logPanel');
  if (!panel) return;
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  entry.innerHTML = `<span class="log-time">[${time}]</span>${message}`;
  panel.appendChild(entry);
  panel.scrollTop = panel.scrollHeight;
  while (panel.children.length > 300) panel.removeChild(panel.firstChild);
}

function showReconnectBanner(show) {
  const banner = document.getElementById('reconnectBanner');
  if (banner) {
    banner.style.display = show ? 'block' : 'none';
  }
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return '—';
  const diff = Date.now() - timestamp;
  if (diff < 1000) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff/1000)}秒前`;
  if (diff < 3600000) return `${Math.floor(diff/60000)}分钟前`;
  return `${Math.floor(diff/3600000)}小时前`;
}

async function joinRoom(isReconnect = false) {
  const roomId = document.getElementById('roomIdInput').value.trim();
  const name = document.getElementById('nameInput').value.trim() || `用户${Math.floor(Math.random()*9000)+1000}`;
  if (!roomId) { alert('请输入房间号'); return; }

  state.roomId = roomId;
  state.displayName = name;

  if (!isReconnect && !state.localStream) {
    try {
      await initLocalMedia();
    } catch (e) {
      log('error', '获取媒体设备失败: ' + e.message);
      return;
    }
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}`;
  const newWs = new WebSocket(wsUrl);

  newWs.onopen = () => {
    log('info', `WebSocket ${isReconnect ? '重连' : '已连接'}`);
    state.ws = newWs;
    state.isReconnecting = false;
    state.reconnectAttempts = 0;
    showReconnectBanner(false);

    const joinMsg = {
      type: 'join',
      roomId: state.roomId,
      displayName: state.displayName,
      mode: state.mode
    };
    if (isReconnect && state.clientId) {
      joinMsg.reconnectClientId = state.clientId;
    }
    sendWS(joinMsg);
  };

  newWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleSignalingMessage(msg);
    } catch (e) {
      console.error('消息解析失败', e);
    }
  };

  newWs.onclose = (e) => {
    log('warn', `WebSocket 已断开 (code=${e.code})`);
    if (state.joined) {
      state.isReconnecting = true;
      showReconnectBanner(true);
      attemptReconnect();
    }
  };

  newWs.onerror = () => log('error', 'WebSocket 错误');

  state.ws = newWs;
}

function attemptReconnect() {
  state.reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, Math.min(state.reconnectAttempts - 1, 5)), 10000);

  log('warn', `${state.reconnectAttempts} 秒后尝试第 ${state.reconnectAttempts} 次重连...`);

  setTimeout(() => {
    if (!state.joined) return;
    if (!state.ws || state.ws.readyState === WebSocket.CLOSED) {
      joinRoom(true);
    }
  }, delay);
}

async function initLocalMedia() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
    });
    addLocalVideo();
    log('success', '本地音视频设备已获取');
  } catch (e) {
    log('error', `设备获取失败: ${e.message}`);
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      addLocalVideo();
      log('warn', '仅获取到音频');
    } catch (e2) {
      throw new Error('无法获取音视频设备');
    }
  }
}

function addLocalVideo() {
  const grid = document.getElementById('videoGrid');
  let card = document.getElementById('video-local');
  if (!card) {
    card = createVideoCard('local', state.displayName || '我', true);
    grid.appendChild(card);
  }
  const video = card.querySelector('video');
  video.muted = true;
  video.srcObject = state.localStream;
  video.play().catch(() => {});
  updateParticipantsList();
}

function createVideoCard(id, name, isLocal = false) {
  const card = document.createElement('div');
  card.className = 'video-card';
  card.id = `video-${id}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.style.display = 'block';
  if (isLocal) video.muted = true;

  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder';
  placeholder.id = `placeholder-${id}`;
  placeholder.style.display = 'flex';
  placeholder.innerHTML = `
    <div class="avatar">${(name || '?').charAt(0).toUpperCase()}</div>
    <div style="font-size:14px;color:#a8b2d1;">等待媒体流...</div>
  `;

  const indicator = document.createElement('div');
  indicator.className = 'video-indicator';
  indicator.innerHTML = `
    <div class="indicator-dot" id="audio-ind-${id}">🎤</div>
    <div class="indicator-dot" id="video-ind-${id}">📷</div>
  `;

  const label = document.createElement('div');
  label.className = `video-label ${isLocal ? 'local' : ''}`;
  label.innerHTML = `${name}${isLocal ? ' (我)' : ''} <span id="connstate-${id}" style="opacity:0.7;font-size:11px;margin-left:6px;">连接中...</span>`;

  card.appendChild(video);
  card.appendChild(placeholder);
  card.appendChild(indicator);
  card.appendChild(label);

  return card;
}

function showVideoTrack(clientId, stream) {
  const card = document.getElementById(`video-${clientId}`);
  if (!card) return;
  const video = card.querySelector('video');
  const placeholder = document.getElementById(`placeholder-${clientId}`);
  video.srcObject = stream;
  if (placeholder) placeholder.style.display = 'none';
  video.style.display = 'block';
  video.play().catch(e => log('warn', `自动播放被阻止: ${e.message}`));
}

function updateConnectionState(clientId, connState) {
  const el = document.getElementById(`connstate-${clientId}`);
  if (!el) return;
  const stateMap = {
    'new': '🟡 新建',
    'connecting': '🟡 连接中',
    'connected': '🟢 已连接',
    'disconnected': '🟠 已断开',
    'failed': '🔴 失败',
    'closed': '⚫ 已关闭',
    'checking': '🟡 检查中',
    'completed': '🟢 已完成'
  };
  el.textContent = stateMap[connState] || connState;
  el.style.color = (connState === 'connected' || connState === 'completed')
    ? '#36d399'
    : (connState === 'failed' || connState === 'disconnected' ? '#f5576c' : '#fbbf24');
}

function sendWS(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function handleSignalingMessage(msg) {
  switch (msg.type) {
    case 'joined':
      handleJoined(msg);
      break;
    case 'peer_joined':
      handlePeerJoined(msg);
      break;
    case 'peer_left':
      handlePeerLeft(msg);
      break;
    case 'offer':
      handleOffer(msg);
      break;
    case 'answer':
      handleAnswer(msg);
      break;
    case 'ice_candidate':
      handleIceCandidate(msg);
      break;
    case 'ice_state':
      handleIceState(msg);
      break;
    case 'connection_state':
      handleConnectionState(msg);
      break;
    case 'owner_changed':
      handleOwnerChanged(msg);
      break;
    case 'kicked':
      handleKicked(msg);
      break;
    case 'owner_resync_all':
      handleOwnerResyncAll(msg);
      break;
    case 'owner_kick_ok':
      log('success', `已成功移出用户`);
      break;
    case 'owner_transfer_ok':
      log('success', `房主转让成功`);
      break;
    case 'owner_resync_all_ok':
      log('success', `已发送全员重连指令`);
      break;
    case 'sfu_route_info':
      log('info', `SFU 路由建立: 新增 ${msg.routes.totalRoutesAdded} 条, 发布者=${msg.routes.incomingPublishers.length}, 订阅者=${msg.routes.outgoingSubscribers.length}`);
      break;
    case 'sfu_available_track':
      handleSfuAvailableTrack(msg);
      break;
    case 'sfu_track_removed':
      handleSfuTrackRemoved(msg);
      if (msg.sfuStats) { state.lastSfuStats = msg.sfuStats; updateStatusPanel(); }
      break;
    case 'sfu_publish_ok':
      log('success', `SFU 发布成功，轨道数=${msg.tracks.length}`);
      if (msg.sfuStats) { state.lastSfuStats = msg.sfuStats; updateStatusPanel(); }
      break;
    case 'sfu_subscribe_ok':
      log('info', `SFU 订阅成功: ${msg.publisherId} - ${msg.trackId}`);
      if (msg.sfuStats) { state.lastSfuStats = msg.sfuStats; updateStatusPanel(); }
      break;
    case 'sfu_media_packet':
      handleSfuMediaPacket(msg);
      break;
    case 'sfu_media_ack':
      handleSfuMediaAck(msg);
      break;
    case 'sfu_media_stats_update':
      handleSfuMediaStatsUpdate(msg);
      break;
    case 'sfu_request_full_sync':
      handleSfuRequestFullSync(msg);
      break;
    case 'chat':
      handleChat(msg);
      break;
    case 'room_info':
      state.lastRoomInfo = msg;
      if (msg.roomEvents) {
        state.roomEvents = msg.roomEvents;
        renderRoomEvents();
      }
      updateStatusPanel(msg);
      renderHealthOverview(msg.health);
      renderDiagnosticsPanel(msg);
      updateOwnerControls(msg);
      
      if (pendingExport) {
        pendingExport = false;
        doExportDiagnostics();
      }
      break;
    case 'room_event':
      handleRoomEvent(msg);
      break;
    case 'error':
      log('error', `错误 [${msg.code}]: ${msg.message}`);
      if (msg.code === 'NOT_OWNER') {
        alert('只有房主可以执行此操作');
      }
      break;
    case 'pong':
    case 'reconnect_ack_ok':
      break;
    case 'owner_force_reconnect':
      handleOwnerForceReconnect(msg);
      break;
    case 'owner_rebuild_subscription':
      handleOwnerRebuildSubscription(msg);
      break;
    case 'owner_clear_state':
      handleOwnerClearState(msg);
      break;
    case 'peer_state_cleared':
      handlePeerStateCleared(msg);
      break;
    default:
      log('warn', `未知消息类型: ${msg.type}`);
  }
}

function handleJoined(msg) {
  state.clientId = msg.clientId;
  state.joined = true;
  state.isOwner = msg.isOwner;
  state.ownerId = msg.ownerId;
  state.lastSfuStats = msg.sfuStats;
  state.lastPerClientStats = msg.sfuPerClientStats;

  document.getElementById('loginSection').classList.add('hidden');
  document.getElementById('roomSection').classList.remove('hidden');
  document.getElementById('currentRoom').textContent = state.roomId;
  document.getElementById('currentMode').textContent = state.mode.toUpperCase();
  document.getElementById('myClientId').textContent = state.clientId;
  state.displayName = msg.displayName;

  const sfuCtrl = document.getElementById('sfuMediaControl');
  if (sfuCtrl) {
    if (state.mode === 'sfu') sfuCtrl.classList.remove('hidden');
    else sfuCtrl.classList.add('hidden');
  }

  updateOwnerControls();
  updateSfuSeqBadge();

  if (msg.isReconnect) {
    log('success', `重连成功，ID=${msg.clientId}`);
    for (const [peerId, peer] of state.peers) {
      if (peer.pc) {
        try { peer.pc.close(); } catch (e) {}
      }
    }
    state.peers.clear();
    const grid = document.getElementById('videoGrid');
    Array.from(grid.children).forEach(c => {
      if (c.id !== 'video-local') c.remove();
    });
  } else {
    log('success', `已加入房间，ID=${msg.clientId}，模式=${msg.mode.toUpperCase()}，房主=${msg.isOwner ? '是我' : msg.ownerId}`);
  }

  if (msg.peers && msg.peers.length > 0) {
    const otherPeers = msg.peers.filter(p => p.clientId !== state.clientId);
    log('info', `房间内已有 ${otherPeers.length} 人，自动建立连接...`);
    for (const peer of otherPeers) {
      state.peers.set(peer.clientId, { displayName: peer.displayName, isOwner: peer.isOwner });
      const grid = document.getElementById('videoGrid');
      if (!document.getElementById(`video-${peer.clientId}`)) {
        const card = createVideoCard(peer.clientId, peer.displayName);
        grid.appendChild(card);
      }
      if (peer.isOwner) {
        updateConnectionState(peer.clientId, peer.connectionStates ? (peer.connectionStates[state.clientId] || 'connecting') : 'connecting');
      }
    }
    updateParticipantsList();
    updateConnectionState('local', 'connected');

    otherPeers.forEach(peer => initiateConnection(peer.clientId, true));
  } else {
    updateConnectionState('local', 'connected');
  }

  setTimeout(() => startPublishing(), 500);

  setInterval(() => {
    if (state.joined) sendWS({ type: 'get_room_info' });
  }, 4000);
}

function handlePeerJoined(msg) {
  const { clientId, displayName, isOwner, isReconnect } = msg;
  if (clientId === state.clientId) return;

  log('info', `${isReconnect ? '用户重连' : '新成员加入'}: ${displayName} (${clientId})`);

  if (!state.peers.has(clientId)) {
    state.peers.set(clientId, { displayName, isOwner });
  } else {
    const p = state.peers.get(clientId);
    p.displayName = displayName;
    p.isOwner = isOwner;
    if (p.pc) {
      try { p.pc.close(); } catch (e) {}
    }
    const oldCard = document.getElementById(`video-${clientId}`);
    if (oldCard) oldCard.remove();
  }

  const grid = document.getElementById('videoGrid');
  let card = document.getElementById(`video-${clientId}`);
  if (!card) {
    card = createVideoCard(clientId, displayName);
    grid.appendChild(card);
  }
  updateParticipantsList();

  initiateConnection(clientId, false);
}

function handlePeerLeft(msg) {
  const id = msg.clientId;
  if (id === state.clientId) return;

  log('warn', `${msg.displayName || id} 离开了房间 (原因: ${msg.reason || '主动离开'})`);

  const peer = state.peers.get(id);
  if (peer && peer.pc) {
    try { peer.pc.close(); } catch (e) {}
  }
  state.peers.delete(id);

  const card = document.getElementById(`video-${id}`);
  if (card) card.remove();

  updateParticipantsList();

  if (msg.newOwnerId) {
    state.ownerId = msg.newOwnerId;
    state.isOwner = msg.newOwnerId === state.clientId;
    if (state.isOwner) {
      log('success', `👑 你已成为新房主`);
    } else {
      log('info', `新房主: ${msg.newOwnerName || msg.newOwnerId}`);
    }
    updateOwnerControls();
  }

  if (msg.sfuStats) {
    state.lastSfuStats = msg.sfuStats;
    state.lastPerClientStats = msg.sfuPerClientStats;
    updateStatusPanel();
    log('info', `SFU 统计已更新: 活跃路由=${msg.sfuStats.activeRoutes}, 已转发包=${formatNumber(msg.sfuStats.totalPacketsForwarded)}`);
  }
}

function handleOwnerChanged(msg) {
  state.ownerId = msg.newOwnerId;
  state.isOwner = msg.newOwnerId === state.clientId;
  if (state.isOwner) {
    log('success', `👑 你已成为新房主 (${msg.reason || '房主转让'})`);
    document.getElementById('ownerStatus').textContent = '👑 你是房主';
  } else {
    log('info', `新房主: ${msg.newOwnerName || msg.newOwnerId} (${msg.reason || '房主转让'})`);
    document.getElementById('ownerStatus').textContent = `房主: ${msg.newOwnerName || msg.newOwnerId}`;
  }
  updateOwnerControls();
  updateParticipantsList();
}

function handleKicked(msg) {
  log('error', `你已被 ${msg.byName || msg.by} 移出房间，原因: ${msg.reason || '未说明'}`);
  alert(`你已被 ${msg.byName || '房主'} 移出房间，原因: ${msg.reason || '未说明'}`);
  leaveRoom(true);
}

function handleOwnerResyncAll(msg) {
  log('warn', `房主 ${msg.byName || msg.by} 请求全员重新同步连接`);

  for (const [peerId, peer] of state.peers) {
    if (peer.pc) {
      try { peer.pc.close(); } catch (e) {}
    }
    const card = document.getElementById(`video-${peerId}`);
    if (card) card.remove();
  }
  state.peers.clear();

  const grid = document.getElementById('videoGrid');
  Array.from(grid.children).forEach(c => {
    if (c.id !== 'video-local') c.remove();
  });

  sendWS({ type: 'get_room_info' });

  setTimeout(() => {
    if (!state.lastRoomInfo) return;
    state.lastRoomInfo.peers.forEach(peer => {
      if (peer.clientId === state.clientId) return;
      state.peers.set(peer.clientId, { displayName: peer.displayName, isOwner: peer.isOwner });
      const card = createVideoCard(peer.clientId, peer.displayName);
      grid.appendChild(card);
      initiateConnection(peer.clientId, true);
    });
    updateParticipantsList();
    setTimeout(() => startPublishing(), 300);
  }, 500);
}

function handleOwnerForceReconnect(msg) {
  log('warn', `房主 ${msg.byName || msg.by} 要求你重新连接，原因: ${msg.reason || '未说明'}`);
  alert(`房主要求你重新连接：${msg.reason || '连接异常'}\n系统将自动重新连接...`);

  for (const [peerId, peer] of state.peers) {
    if (peer.pc) {
      try { peer.pc.close(); } catch (e) {}
    }
    const card = document.getElementById(`video-${peerId}`);
    if (card) card.remove();
  }
  state.peers.clear();

  const grid = document.getElementById('videoGrid');
  Array.from(grid.children).forEach(c => {
    if (c.id !== 'video-local') c.remove();
  });

  setTimeout(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.close();
    }
  }, 200);
}

function handleOwnerRebuildSubscription(msg) {
  log('warn', `房主 ${msg.byName || msg.by} 要求你重建订阅`);

  if (msg.publisherId) {
    const peer = state.peers.get(msg.publisherId);
    if (peer && peer.pc) {
      try { peer.pc.close(); } catch (e) {}
      state.peers.delete(msg.publisherId);
      const card = document.getElementById(`video-${msg.publisherId}`);
      if (card) card.remove();
      
      setTimeout(() => {
        state.peers.set(msg.publisherId, { displayName: peer.displayName, isOwner: peer.isOwner });
        const grid = document.getElementById('videoGrid');
        const card = createVideoCard(msg.publisherId, peer.displayName);
        grid.appendChild(card);
        initiateConnection(msg.publisherId, true);
      }, 300);
    }
  } else {
    for (const [peerId, peer] of state.peers) {
      if (peer.pc) {
        try { peer.pc.close(); } catch (e) {}
      }
      const card = document.getElementById(`video-${peerId}`);
      if (card) card.remove();
    }
    state.peers.clear();

    const grid = document.getElementById('videoGrid');
    Array.from(grid.children).forEach(c => {
      if (c.id !== 'video-local') c.remove();
    });

    sendWS({ type: 'get_room_info' });

    setTimeout(() => {
      if (!state.lastRoomInfo) return;
      state.lastRoomInfo.peers.forEach(peer => {
        if (peer.clientId === state.clientId) return;
        state.peers.set(peer.clientId, { displayName: peer.displayName, isOwner: peer.isOwner });
        const card = createVideoCard(peer.clientId, peer.displayName);
        grid.appendChild(card);
        initiateConnection(peer.clientId, true);
      });
      updateParticipantsList();
    }, 500);
  }
}

function handleOwnerClearState(msg) {
  log('warn', `房主 ${msg.byName || msg.by} 清空了你的连接状态`);

  for (const [peerId, peer] of state.peers) {
    if (peer.connectionStates) {
      delete peer.connectionStates[state.clientId];
    }
    if (peer.iceStates) {
      delete peer.iceStates[state.clientId];
    }
    updateConnectionState(peerId, 'reconnecting');
  }

  sendWS({ type: 'get_room_info' });
}

function handlePeerStateCleared(msg) {
  log('info', `${msg.targetName || msg.targetClientId} 的连接状态已被房主清空`);
  
  const peer = state.peers.get(msg.targetClientId);
  if (peer) {
    if (peer.connectionStates) {
      delete peer.connectionStates[state.clientId];
    }
    if (peer.iceStates) {
      delete peer.iceStates[state.clientId];
    }
    updateConnectionState(msg.targetClientId, 'reconnecting');
  }

  sendWS({ type: 'get_room_info' });
}

function handleOffer(msg) {
  const from = msg.from;
  log('info', `收到来自 ${from} 的 Offer`);
  const peer = getOrCreatePeer(from);

  if (state.localStream && !peer.tracksAdded) {
    state.localStream.getTracks().forEach(track => {
      try { peer.pc.addTrack(track, state.localStream); } catch (e) {}
    });
    peer.tracksAdded = true;
    sendTrackCount();
  }

  peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
    .then(() => peer.pc.createAnswer())
    .then(answer => peer.pc.setLocalDescription(answer))
    .then(() => {
      sendWS({ type: 'answer', to: from, sdp: peer.pc.localDescription });
      log('success', `已发送 Answer 给 ${from}`);
    })
    .catch(e => log('error', `处理 Offer 失败: ${e.message}`));
}

function handleAnswer(msg) {
  const from = msg.from;
  log('info', `收到来自 ${from} 的 Answer`);
  const peer = state.peers.get(from);
  if (peer && peer.pc) {
    peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
      .then(() => log('success', `与 ${from} 的 SDP 协商完成`))
      .catch(e => log('error', `设置远程描述失败: ${e.message}`));
  }
}

function handleIceCandidate(msg) {
  const from = msg.from;
  const peer = state.peers.get(from);
  const pc = peer ? peer.pc : null;
  if (pc && msg.candidate) {
    pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
      .catch(() => {});
  }
}

function handleIceState(msg) {
  const { from, state: iceState } = msg;
  const peer = state.peers.get(from);
  if (peer) peer.iceState = iceState;
}

function handleConnectionState(msg) {
  const { from, state: connState } = msg;
  updateConnectionState(from, connState);
}

function getOrCreatePeer(peerId) {
  let peer = state.peers.get(peerId);
  if (peer && peer.pc && peer.pc.connectionState !== 'closed' && peer.pc.connectionState !== 'failed') {
    return peer;
  }
  if (!peer) peer = { displayName: peerId, isOwner: false };
  if (peer.pc) {
    try { peer.pc.close(); } catch (e) {}
  }

  const pc = new RTCPeerConnection(state.rtcConfig);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendWS({ type: 'ice_candidate', to: peerId, candidate: e.candidate });
    }
  };

  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === 'complete') {
      log('info', `ICE 收集完成 [${peerId}]`);
    }
    sendWS({ type: 'ice_state', peerId, state: pc.iceGatheringState });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    sendWS({ type: 'ice_state', peerId, state: s });
    if (s === 'failed') {
      log('warn', `ICE 连接失败 [${peerId}]，尝试重启 ICE`);
      try {
        pc.restartIce();
      } catch (e) {
        log('error', `ICE 重启失败: ${e.message}`);
      }
    } else if (s === 'disconnected') {
      log('warn', `ICE 连接断开 [${peerId}]`);
    } else if (s === 'connected' || s === 'completed') {
      log('success', `ICE 连接成功 [${peerId}]: ${s}`);
    }
  };

  pc.ontrack = (e) => {
    if (!peer.stream) peer.stream = new MediaStream();
    e.streams[0].getTracks().forEach(t => {
      if (!peer.stream.getTrackById(t.id)) {
        peer.stream.addTrack(t);
      }
    });
    showVideoTrack(peerId, peer.stream);
    log('success', `收到来自 ${peerId} 的媒体轨: ${e.track.kind}`);
    sendTrackCount();
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    log('info', `连接状态 [${peerId}]: ${s}`);
    updateConnectionState(peerId, s);
    sendWS({ type: 'connection_state', peerId, state: s });
  };

  peer.pc = pc;
  peer.stream = peer.stream || null;
  peer.tracksAdded = false;
  peer.iceState = 'new';
  state.peers.set(peerId, peer);
  return peer;
}

function sendTrackCount() {
  if (!state.localStream) return;
  const tracks = state.localStream.getTracks();
  sendWS({
    type: 'track_count',
    audio: tracks.filter(t => t.kind === 'audio').length,
    video: tracks.filter(t => t.kind === 'video').length,
    total: tracks.length
  });
}

function initiateConnection(peerId, isInitiator) {
  if (peerId === state.clientId) return;
  const peer = getOrCreatePeer(peerId);
  const pc = peer.pc;

  if (state.localStream && !peer.tracksAdded) {
    state.localStream.getTracks().forEach(track => {
      try { pc.addTrack(track, state.localStream); } catch (e) {}
    });
    peer.tracksAdded = true;
    sendTrackCount();
  }

  if (isInitiator) {
    const delay = Math.floor(Math.random() * 300) + 100;
    setTimeout(() => {
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') return;
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
          sendWS({ type: 'offer', to: peerId, sdp: pc.localDescription });
          log('info', `已发送 Offer 给 ${peerId}`);
        })
        .catch(e => log('error', `创建 Offer 失败 [${peerId}]: ${e.message}`));
    }, delay);
  }
}

function startPublishing() {
  if (state.mode === 'sfu' && state.localStream) {
    const tracks = [];
    state.localStream.getTracks().forEach(track => {
      const trackId = `${track.kind}-${state.clientId}`;
      tracks.push({ trackId, kind: track.kind });
    });
    if (tracks.length > 0) {
      sendWS({ type: 'sfu_publish', tracks });
      log('info', `SFU: 正在发布 ${tracks.length} 条轨道...`);
    }
  }
}

function handleSfuAvailableTrack(msg) {
  const { publisherId, tracks } = msg;
  if (publisherId === state.clientId) return;
  log('info', `SFU: ${publisherId} 发布了 ${tracks.length} 条轨道，自动订阅`);

  tracks.forEach(t => {
    sendWS({ type: 'sfu_subscribe', publisherId, trackId: t.trackId, kind: t.kind });
  });
}

function handleSfuTrackRemoved(msg) {
  const { publisherId, trackId } = msg;
  log('warn', `SFU: ${publisherId} 的轨道 ${trackId} 已移除`);
}

function handleSfuRequestFullSync(msg) {
  if (msg.from === state.clientId) return;
  if (state.mode === 'sfu' && state.localStream) {
    const tracks = state.localStream.getTracks().map(t => ({
      trackId: `${t.kind}-${state.clientId}`,
      kind: t.kind
    }));
    if (tracks.length > 0) {
      sendWS({ type: 'sfu_publish', tracks });
    }
  }
}

function sendMediaPacket(count = 1) {
  if (!state.joined || state.mode !== 'sfu') {
    log('warn', '仅 SFU 模式支持发送模拟媒体包');
    return;
  }
  if (!state.localStream) {
    log('warn', '请先获取媒体设备');
    return;
  }
  const videoTrack = state.localStream.getVideoTracks()[0];
  const trackId = videoTrack ? `video-${state.clientId}` : `audio-${state.clientId}`;

  sendWS({
    type: 'sfu_media_packet_in',
    trackId,
    kind: videoTrack ? 'video' : 'audio',
    seq: state.sfuMediaSeq,
    count
  });
  log('info', `已发送 ${count} 个模拟媒体包 (seq=${state.sfuMediaSeq})`);
}

function updateSfuSeqBadge() {
  const el = document.getElementById('sfuSeqBadge');
  if (el) el.textContent = `当前 Seq: ${state.sfuMediaSeq}`;
}

function handleSfuMediaPacket(msg) {
  const { from, trackId, kind, seq, size, ts, totalForRoute } = msg;
  const fromClient = state.peers.get(from);
  const fromName = fromClient ? fromClient.displayName : from;
  log('success', `收到 SFU 转发媒体包: ${fromName} → 我, track=${trackId}, kind=${kind}, seq=${seq}, size=${size}B, 累计=${totalForRoute || '?'}个`);
}

function handleSfuMediaAck(msg) {
  const {
    trackId, kind, seqStart, seqEnd,
    packetsSent, totalReceivers, totalForwardedPackets,
    receiverSummary, sfuStats, sfuPerClientStats
  } = msg;

  let summaryHtml = `<strong>✅ 发送成功:</strong> ${packetsSent} 个 ${kind} 包 `;
  summaryHtml += `<span style="color:#4facfe;">→</span> 转发给 <strong>${totalReceivers}</strong> 人 `;
  summaryHtml += `共 <strong style="color:#36d399;">${totalForwardedPackets}</strong> 次转发 (seq ${seqStart}-${seqEnd})`;

  if (receiverSummary && receiverSummary.length > 0) {
    summaryHtml += '<br><strong>接收明细:</strong><ul style="margin:4px 0 0 16px; padding:0;">';
    receiverSummary.forEach(r => {
      const receiverClient = state.peers.get(r.receiverId);
      const name = receiverClient ? receiverClient.displayName : r.receiverId;
      summaryHtml += `<li>${name}: 本次转发 ${r.count} 个, 累计 ${formatNumber(r.totalPackets)} 个 / ${formatBytes(r.totalBytes)}</li>`;
    });
    summaryHtml += '</ul>';
  }

  const summaryEl = document.getElementById('mediaForwardingSummary');
  if (summaryEl) {
    summaryEl.style.display = 'block';
    summaryEl.innerHTML = summaryHtml;
  }

  log('success', `SFU 转发确认: ${packetsSent} 包 × ${totalReceivers} 人 = ${totalForwardedPackets} 次转发`);

  state.sfuMediaSeq = seqEnd + 1;
  updateSfuSeqBadge();

  if (sfuStats) {
    state.lastSfuStats = sfuStats;
    state.lastPerClientStats = sfuPerClientStats;
    updateStatusPanel();
  }
}

function handleSfuMediaStatsUpdate(msg) {
  const { publisherId, publisherName, trackId, kind, lastSeq, packetsReceived, totalForThisPublisher, sfuStats, sfuPerClientStats } = msg;
  log('info', `SFU 统计更新: ${publisherName} 最新 seq=${lastSeq}, 我已收到 ${formatNumber(totalForThisPublisher)} 个包`);
  if (sfuStats) {
    state.lastSfuStats = sfuStats;
    state.lastPerClientStats = sfuPerClientStats;
    updateStatusPanel();
  }
}

function handleChat(msg) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const isMe = msg.from === state.clientId;
  div.innerHTML = `<span class="sender">${isMe ? '我' : msg.displayName}:</span>${msg.text}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  sendWS({ type: 'chat', text });
  input.value = '';
}

function toggleMic() {
  state.audioEnabled = !state.audioEnabled;
  if (state.localStream) {
    state.localStream.getAudioTracks().forEach(t => t.enabled = state.audioEnabled);
  }
  document.getElementById('micBtn').textContent = state.audioEnabled ? '🎤 静音' : '🔇 取消静音';
  const ind = document.getElementById('audio-ind-local');
  if (ind) {
    ind.className = 'indicator-dot' + (state.audioEnabled ? '' : ' muted');
    ind.textContent = state.audioEnabled ? '🎤' : '🔇';
  }
  log('info', `麦克风已${state.audioEnabled ? '开启' : '关闭'}`);
  sendTrackCount();
}

function toggleCam() {
  state.videoEnabled = !state.videoEnabled;
  if (state.localStream) {
    state.localStream.getVideoTracks().forEach(t => t.enabled = state.videoEnabled);
  }
  document.getElementById('camBtn').textContent = state.videoEnabled ? '📷 关摄像头' : '📷 开摄像头';
  const ind = document.getElementById('video-ind-local');
  if (ind) {
    ind.className = 'indicator-dot' + (state.videoEnabled ? '' : ' muted');
    ind.textContent = state.videoEnabled ? '📷' : '🚫';
  }
  const placeholder = document.getElementById('placeholder-local');
  if (placeholder) {
    placeholder.style.display = state.videoEnabled ? 'none' : 'flex';
  }
  log('info', `摄像头已${state.videoEnabled ? '开启' : '关闭'}`);
  sendTrackCount();
}

async function switchCamera() {
  if (!state.localStream) return;
  try {
    const videoTrack = state.localStream.getVideoTracks()[0];
    if (!videoTrack) return;

    const currentSettings = videoTrack.getSettings();
    const newFacingMode = currentSettings.facingMode === 'user' ? 'environment' : 'user';

    videoTrack.stop();

    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: newFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } }
    });

    const newVideoTrack = newStream.getVideoTracks()[0];
    state.localStream.removeTrack(videoTrack);
    state.localStream.addTrack(newVideoTrack);

    const localVideo = document.querySelector('#video-local video');
    localVideo.srcObject = null;
    localVideo.srcObject = state.localStream;

    for (const [peerId, peer] of state.peers) {
      if (peer.pc && peer.pc.connectionState !== 'closed') {
        const senders = peer.pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender) videoSender.replaceTrack(newVideoTrack);
      }
    }

    if (state.mode === 'sfu') {
      startPublishing();
    }

    log('success', `摄像头切换为 ${newFacingMode === 'user' ? '前置' : '后置'}`);
    sendTrackCount();
  } catch (e) {
    log('error', `切换摄像头失败: ${e.message}`);
  }
}

function leaveRoom(isKicked = false) {
  if (!isKicked) {
    sendWS({ type: 'leave' });
  }
  state.joined = false;
  state.isOwner = false;
  state.ownerId = null;
  state.isReconnecting = false;
  state.reconnectAttempts = 0;

  for (const [peerId, peer] of state.peers) {
    if (peer.pc) { try { peer.pc.close(); } catch (e) {} }
  }
  state.peers.clear();
  state.sfuMediaSeq = 1;
  state.lastSfuStats = null;
  state.lastPerClientStats = null;
  state.lastRoomInfo = null;

  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }

  if (state.ws) {
    try { state.ws.close(); } catch (e) {}
    state.ws = null;
  }

  showReconnectBanner(false);

  document.getElementById('roomSection').classList.add('hidden');
  document.getElementById('loginSection').classList.remove('hidden');
  document.getElementById('videoGrid').innerHTML = '';
  document.getElementById('participantsList').innerHTML = '';
  document.getElementById('chatMessages').innerHTML = '';
  document.getElementById('logPanel').innerHTML = '';
  document.getElementById('statusPanel').innerHTML = '';
  document.getElementById('diagnosticsPanel').innerHTML = '<div style="color:#8892b0; font-size:13px;">等待诊断数据...</div>';
  document.getElementById('ownerControl').classList.add('hidden');
  document.getElementById('ownerStatus').textContent = '';
  document.getElementById('sfuMediaControl').classList.add('hidden');
  document.getElementById('mediaForwardingSummary').style.display = 'none';
  document.getElementById('roomEventsPanel').innerHTML = '<div style="color:#8892b0;">等待事件...</div>';
  state.roomEvents = [];
}

function updateParticipantsList() {
  const list = document.getElementById('participantsList');
  const countEl = document.getElementById('participantCount');
  if (!list) return;
  list.innerHTML = '';
  const items = [{
    id: state.clientId,
    name: state.displayName || '我',
    isLocal: true,
    isOwner: state.isOwner
  }];
  for (const [id, peer] of state.peers) {
    items.push({ id, name: peer.displayName || id, isLocal: false, isOwner: peer.isOwner });
  }
  countEl.textContent = items.length;
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'participant-item';
    div.innerHTML = `
      <div class="participant-info">
        <div class="status-dot"></div>
        <div class="participant-avatar">${item.name.charAt(0).toUpperCase()}</div>
        <div>
          <div style="font-weight:600;">
            ${item.name}${item.isLocal ? ' (我)' : ''}
            ${item.isOwner ? ' <span style="color:#fbbf24; font-size:11px;">👑房主</span>' : ''}
          </div>
          <div style="font-size:11px;color:#8892b0;">${item.id}</div>
        </div>
      </div>
    `;
    list.appendChild(div);
  });

  const kickSelect = document.getElementById('kickTarget');
  const transferSelect = document.getElementById('transferTarget');
  if (kickSelect) {
    kickSelect.innerHTML = '<option value="">选择要移出的成员...</option>';
    for (const [id, peer] of state.peers) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${peer.displayName || id}${peer.isOwner ? ' (房主)' : ''}`;
      kickSelect.appendChild(opt);
    }
  }
  if (transferSelect) {
    transferSelect.innerHTML = '<option value="">转让房主给...</option>';
    for (const [id, peer] of state.peers) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${peer.displayName || id}`;
      transferSelect.appendChild(opt);
    }
  }

  const memberFilter = document.getElementById('eventFilterMember');
  if (memberFilter) {
    const currentVal = memberFilter.value;
    let options = '<option value="">所有成员</option>';
    options += `<option value="${state.clientId}">${state.displayName || '我'}</option>`;
    for (const [id, peer] of state.peers) {
      options += `<option value="${id}">${peer.displayName || id}</option>`;
    }
    memberFilter.innerHTML = options;
    memberFilter.value = currentVal;
  }

  const quickActionTarget = document.getElementById('quickActionTarget');
  if (quickActionTarget) {
    const currentVal = quickActionTarget.value;
    let options = '<option value="">选择目标成员...</option>';
    for (const [id, peer] of state.peers) {
      options += `<option value="${id}">${peer.displayName || id}</option>`;
    }
    quickActionTarget.innerHTML = options;
    quickActionTarget.value = currentVal;
  }
}

function updateOwnerControls(roomInfo) {
  const ctrl = document.getElementById('ownerControl');
  const statusEl = document.getElementById('ownerStatus');
  if (!ctrl) return;

  if (state.isOwner) {
    ctrl.classList.remove('hidden');
    statusEl.textContent = '👑 你是房主';
  } else {
    ctrl.classList.add('hidden');
    const ownerName = state.ownerId ? (state.peers.get(state.ownerId) ? state.peers.get(state.ownerId).displayName : state.ownerId) : '—';
    statusEl.textContent = `房主: ${ownerName}`;
  }
}

function ownerKickSelected() {
  const sel = document.getElementById('kickTarget');
  const targetId = sel.value;
  if (!targetId) {
    alert('请选择要移出的成员');
    return;
  }
  const target = state.peers.get(targetId);
  if (!target) return;
  if (confirm(`确定要将 ${target.displayName || targetId} 移出房间吗？`)) {
    sendWS({
      type: 'owner_kick',
      targetClientId: targetId,
      reason: '房主移出'
    });
    sel.value = '';
  }
}

function ownerTransferSelected() {
  const sel = document.getElementById('transferTarget');
  const targetId = sel.value;
  if (!targetId) {
    alert('请选择要转让的成员');
    return;
  }
  const target = state.peers.get(targetId);
  if (!target) return;
  if (confirm(`确定要将房主转让给 ${target.displayName || targetId} 吗？`)) {
    sendWS({
      type: 'owner_transfer',
      newOwnerId: targetId
    });
    sel.value = '';
  }
}

function ownerForceReconnectSelected() {
  const sel = document.getElementById('quickActionTarget');
  const targetId = sel.value;
  if (!targetId) {
    alert('请选择目标成员');
    return;
  }
  const target = state.peers.get(targetId);
  if (!target) return;
  const reason = prompt('请输入重连原因（可选）:', '连接异常');
  if (reason !== null) {
    sendWS({
      type: 'owner_force_reconnect',
      targetClientId: targetId,
      reason: reason || ''
    });
    sel.value = '';
    log('info', `已要求 ${target.displayName || targetId} 重新连接`);
  }
}

function ownerClearStateSelected() {
  const sel = document.getElementById('quickActionTarget');
  const targetId = sel.value;
  if (!targetId) {
    alert('请选择目标成员');
    return;
  }
  const target = state.peers.get(targetId);
  if (!target) return;
  if (confirm(`确定要清空 ${target.displayName || targetId} 的连接状态吗？`)) {
    sendWS({
      type: 'owner_clear_peer_state',
      targetClientId: targetId
    });
    sel.value = '';
    log('info', `已清空 ${target.displayName || targetId} 的连接状态`);
  }
}

function ownerRebuildSubscriptionSelected() {
  const sel = document.getElementById('quickActionTarget');
  const targetId = sel.value;
  if (!targetId) {
    alert('请选择目标成员');
    return;
  }
  const target = state.peers.get(targetId);
  if (!target) return;
  
  const publishers = Array.from(state.peers.keys());
  if (publishers.length === 0) {
    alert('没有其他成员可订阅');
    return;
  }
  
  const publisherId = prompt('输入发布者ID（留空则重建所有订阅）:', '');
  const trackId = publisherId ? prompt('输入轨道ID（留空则重建该发布者的所有订阅）:', '') : '';
  
  if (publisherId !== null && trackId !== null) {
    sendWS({
      type: 'owner_rebuild_subscription',
      targetClientId: targetId,
      publisherId: publisherId || undefined,
      trackId: trackId || undefined
    });
    sel.value = '';
    log('info', `已要求 ${target.displayName || targetId} 重建订阅`);
  }
}

function ownerResyncAll() {
  if (confirm('确定要让全员重新同步连接吗？这会重置所有人的 WebRTC 连接。')) {
    sendWS({ type: 'owner_resync_all' });
  }
}

function forceRefreshDiagnostics() {
  sendWS({ type: 'get_room_info' });
  log('info', '已请求刷新诊断数据');
}

function updateStatusPanel(msg) {
  const panel = document.getElementById('statusPanel');
  if (!panel) return;

  const peers = msg ? msg.peers : null;
  const sfuStats = (msg && msg.sfuStats) ? msg.sfuStats : state.lastSfuStats;
  const peerCount = peers ? peers.length : (state.peers.size + 1);

  const connectedCount = Array.from(state.peers.values()).filter(p =>
    p.pc && (p.pc.connectionState === 'connected' || p.pc.connectionState === 'completed')
  ).length;

  let extraHtml = '';
  if (state.mode === 'sfu') {
    extraHtml = `
      <div class="status-item">
        <div class="label">SFU 活跃路由</div>
        <div class="value">${sfuStats ? sfuStats.activeRoutes : 0}</div>
      </div>
      <div class="status-item">
        <div class="label">SFU 转发总包数</div>
        <div class="value">${sfuStats ? formatNumber(sfuStats.totalPacketsForwarded) : 0}</div>
      </div>
      <div class="status-item">
        <div class="label">SFU 转发总字节</div>
        <div class="value">${sfuStats ? formatBytes(sfuStats.totalBytesForwarded) : '0 B'}</div>
      </div>
      <div class="status-item">
        <div class="label">SFU 已注册客户端</div>
        <div class="value">${sfuStats ? sfuStats.registeredClients : 0}</div>
      </div>
    `;
  }

  panel.innerHTML = `
    <div class="status-item">
      <div class="label">房间人数</div>
      <div class="value">${peerCount}</div>
    </div>
    <div class="status-item">
      <div class="label">连接模式</div>
      <div class="value">${state.mode.toUpperCase()}</div>
    </div>
    <div class="status-item">
      <div class="label">已建立连接</div>
      <div class="value">${connectedCount} / ${state.peers.size}</div>
    </div>
    <div class="status-item">
      <div class="label">我的媒体轨</div>
      <div class="value">${state.localStream ? state.localStream.getTracks().length : 0}</div>
    </div>
    ${extraHtml}
  `;
}

function renderHealthOverview(health) {
  if (!health) return;

  const scoreEl = document.getElementById('healthScore');
  const statusEl = document.getElementById('healthStatus');
  const alertsEl = document.getElementById('healthAlerts');

  scoreEl.textContent = health.score;

  let statusColor = 'background:#36d399; color:#000;';
  let statusText = '🟢 健康';
  if (health.status === 'critical') {
    statusColor = 'background:#f5576c; color:#fff;';
    statusText = '🔴 严重';
    scoreEl.style.color = '#f5576c';
  } else if (health.status === 'warning') {
    statusColor = 'background:#fbbf24; color:#000;';
    statusText = '🟡 警告';
    scoreEl.style.color = '#fbbf24';
  } else {
    scoreEl.style.color = '#36d399';
  }

  statusEl.style.cssText = statusColor;
  statusEl.textContent = statusText;

  document.getElementById('statTotalPeers').textContent = health.totalPeers || 0;
  document.getElementById('statDisconnected').textContent = health.disconnectedCount || 0;
  document.getElementById('statIceFailed').textContent = health.iceFailedCount || 0;
  document.getElementById('statNoMedia').textContent = health.noMediaCount || 0;
  document.getElementById('statReconnects').textContent = health.recentReconnectCount || 0;

  alertsEl.innerHTML = '';
  if (health.alerts && health.alerts.length > 0) {
    health.alerts.forEach(alert => {
      let alertColor = '#4facfe';
      if (alert.level === 'error') alertColor = '#f5576c';
      else if (alert.level === 'warning') alertColor = '#fbbf24';
      
      const badge = document.createElement('span');
      badge.style.cssText = `padding:4px 8px; border-radius:4px; background:${alertColor}22; color:${alertColor}; font-size:11px; font-weight:600;`;
      badge.textContent = `⚠️ ${alert.message}`;
      alertsEl.appendChild(badge);
    });
  } else {
    const badge = document.createElement('span');
    badge.style.cssText = 'padding:4px 8px; border-radius:4px; background:#36d39922; color:#36d399; font-size:11px; font-weight:600;';
    badge.textContent = '✅ 所有系统正常';
    alertsEl.appendChild(badge);
  }
}

function renderDiagnosticsPanel(roomInfo) {
  const panel = document.getElementById('diagnosticsPanel');
  if (!panel || !roomInfo || !roomInfo.peers) return;

  let html = '';
  const sfuPerClient = roomInfo.sfuPerClientStats || {};

  roomInfo.peers.forEach(peer => {
    const isMe = peer.clientId === state.clientId;
    const isOwner = peer.isOwner;
    const sfuStats = sfuPerClient[peer.clientId] || {};

    const myConnState = peer.connectionStates ? peer.connectionStates[state.clientId] : null;
    const myIceState = peer.iceStates ? peer.iceStates[state.clientId] : null;

    const tracks = peer.trackCount || { audio: 0, video: 0, total: 0 };

    let connBadge = 'connecting';
    let connText = '未连接';
    if (isMe) {
      connBadge = 'connected';
      connText = '本人';
    } else if (myConnState === 'connected' || myConnState === 'completed') {
      connBadge = 'connected';
      connText = '已连接';
    } else if (myConnState === 'failed') {
      connBadge = 'failed';
      connText = '连接失败';
    } else if (myConnState) {
      connBadge = 'connecting';
      connText = myConnState;
    }

    let breakdownHtml = '';
    if (peer.sfuMediaStats) {
      const stats = peer.sfuMediaStats;
      const perReceiver = stats.perReceiverBreakdown || {};
      const perPublisher = stats.perPublisherBreakdown || {};

      const receiverEntries = Object.entries(perReceiver).filter(([k, v]) =>
        isMe || v.receiverId === state.clientId
      );
      const publisherEntries = Object.entries(perPublisher).filter(([k, v]) =>
        isMe || v.publisherId === state.clientId
      );

      if (receiverEntries.length > 0 || publisherEntries.length > 0) {
        breakdownHtml += '<div class="diagnostic-section-title">SFU 媒体包统计</div>';
        breakdownHtml += '<div class="diagnostic-breakdown">';

        if (receiverEntries.length > 0) {
          breakdownHtml += `<div style="color:#8892b0; margin-bottom:4px; font-weight:600;">→ 转发给他人 (发送明细):</div>`;
          receiverEntries.forEach(([key, val]) => {
            const peerClient = state.peers.get(val.receiverId);
            const name = peerClient ? peerClient.displayName : val.receiverId;
            breakdownHtml += `
              <div class="breakdown-row">
                <span class="peer">${name} (${val.kind})</span>
                <span class="stats">${formatNumber(val.packets)} 包 / ${formatBytes(val.bytes)}</span>
              </div>
            `;
          });
        }

        if (publisherEntries.length > 0) {
          breakdownHtml += `<div style="color:#8892b0; margin:6px 0 4px; font-weight:600;">← 接收自他人 (接收明细):</div>`;
          publisherEntries.forEach(([key, val]) => {
            const peerClient = state.peers.get(val.publisherId);
            const name = peerClient ? peerClient.displayName : val.publisherId;
            breakdownHtml += `
              <div class="breakdown-row">
                <span class="peer">${name} (${val.kind})</span>
                <span class="stats">${formatNumber(val.packets)} 包 / ${formatBytes(val.bytes)}</span>
              </div>
            `;
          });
        }

        breakdownHtml += '</div>';
      }
    }

    const cardClass = `diagnostic-card${isOwner ? ' owner' : ''}${connBadge === 'failed' ? ' disconnected' : ''}`;

    html += `
      <div class="${cardClass}">
        <div class="diagnostic-header">
          <div class="diagnostic-name">
            ${isOwner ? '👑 ' : ''}${peer.displayName || peer.clientId}
            ${isMe ? '<span style="opacity:0.6;font-size:12px;">(我)</span>' : ''}
          </div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            ${isOwner ? '<span class="diagnostic-badge owner">房主</span>' : ''}
            <span class="diagnostic-badge ${connBadge}">${connText}</span>
          </div>
        </div>

        <div class="diagnostic-grid">
          <div class="diagnostic-item">
            <div class="label">客户端 ID</div>
            <div class="value" style="font-size:11px; font-family:Consolas;">${peer.clientId}</div>
          </div>
          <div class="diagnostic-item">
            <div class="label">加入时间</div>
            <div class="value">${formatTimeAgo(peer.joinedAt)}</div>
          </div>
          <div class="diagnostic-item">
            <div class="label">最后信令</div>
            <div class="value">${formatTimeAgo(peer.lastSignalingAt)}</div>
          </div>
          <div class="diagnostic-item">
            <div class="label">连接状态</div>
            <div class="value">${myConnState || (isMe ? '—' : '未知')}</div>
          </div>
          <div class="diagnostic-item">
            <div class="label">ICE 状态</div>
            <div class="value">${myIceState || (isMe ? '—' : '未知')}</div>
          </div>
          <div class="diagnostic-item">
            <div class="label">媒体轨数</div>
            <div class="value">🎤${tracks.audio} 📷${tracks.video}</div>
          </div>
          ${state.mode === 'sfu' ? `
          <div class="diagnostic-item">
            <div class="label">SFU 发送总包</div>
            <div class="value">${peer.sfuMediaStats ? formatNumber(peer.sfuMediaStats.sentPackets) : 0}</div>
          </div>
          <div class="diagnostic-item">
            <div class="label">SFU 接收总包</div>
            <div class="value">${peer.sfuMediaStats ? formatNumber(peer.sfuMediaStats.receivedPackets) : 0}</div>
          </div>
          <div class="diagnostic-item">
            <div class="label">作为发布者路由</div>
            <div class="value">${peer.sfuMediaStats ? peer.sfuMediaStats.routesAsSender : 0}</div>
          </div>
          <div class="diagnostic-item">
            <div class="label">作为订阅者路由</div>
            <div class="value">${peer.sfuMediaStats ? peer.sfuMediaStats.routesAsReceiver : 0}</div>
          </div>
          ` : ''}
        </div>

        ${breakdownHtml}
        ${renderRecentEventsSummary(peer.recentEvents)}
      </div>
    `;
  });

  panel.innerHTML = html;
}

function renderRecentEventsSummary(events) {
  if (!events || events.length === 0) return '';

  const now = Date.now();
  const recentEvents = events.filter(e => now - e.timestamp < 60000);
  if (recentEvents.length === 0) return '';

  const eventTypeLabels = {
    'connection_state': '连接状态',
    'ice_state': 'ICE状态',
    'sfu_publish': '发布轨道',
    'sfu_subscribe': '订阅轨道',
    'sfu_media_packet': '发送媒体包',
    'chat': '聊天',
    'offer': '发送Offer',
    'offer_received': '收到Offer',
    'answer': '发送Answer',
    'answer_received': '收到Answer',
    'join': '加入房间',
    'reconnect': '重连成功',
    'get_room_info': '刷新诊断'
  };

  let html = '<div class="events-summary">';
  html += '<div class="summary-title">最近1分钟事件</div>';

  recentEvents.slice(-8).reverse().forEach(e => {
    const label = eventTypeLabels[e.type] || e.type;
    let desc = label;
    if (e.peerId) {
      const peerClient = state.peers.get(e.peerId);
      const peerName = peerClient ? peerClient.displayName : e.peerId;
      if (e.state) {
        desc += ` → ${peerName}: ${e.state}`;
      } else {
        desc += ` → ${peerName}`;
      }
    } else if (e.trackCount !== undefined) {
      desc += `: ${e.trackCount} 条`;
    } else if (e.packetCount !== undefined) {
      desc += `: ${e.packetCount} 包`;
    }
    const time = new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
    html += `
      <div class="event-row">
        <span class="event-desc">${desc}</span>
        <span class="event-ts">${time}</span>
      </div>
    `;
  });

  html += '</div>';
  return html;
}

function handleRoomEvent(msg) {
  if (!msg.event) return;
  state.roomEvents.push(msg.event);
  if (state.roomEvents.length > 200) {
    state.roomEvents = state.roomEvents.slice(-200);
  }
  renderRoomEvents();
  log('info', `房间事件: ${formatRoomEventDescription(msg.event)}`);
}

function formatRoomEventDescription(event) {
  const { type, timestamp, ...data } = event;
  switch (type) {
    case 'peer_joined':
      return `${data.displayName || data.clientId} 加入房间`;
    case 'peer_reconnect':
      return `${data.displayName || data.clientId} 重新连接`;
    case 'peer_left':
      return `${data.displayName || data.clientId} 离开房间 (${data.reason || '主动离开'})`;
    case 'owner_kick':
      return `${data.byName || data.by} 移出 ${data.targetName || data.targetClientId}`;
    case 'owner_transfer':
      return `${data.previousOwnerName || data.previousOwnerId} 转让房主给 ${data.newOwnerName || data.newOwnerId}`;
    case 'owner_resync_all':
      return `${data.byName || data.by} 请求全员重新同步`;
    case 'owner_force_reconnect':
      return `${data.byName || data.by} 要求 ${data.targetName || data.targetClientId} 重连`;
    case 'owner_rebuild_subscription':
      return `${data.byName || data.by} 要求 ${data.targetName || data.targetClientId} 重建 ${data.trackDesc || '订阅'}`;
    case 'owner_clear_state':
      return `${data.byName || data.by} 清空了 ${data.targetName || data.targetClientId} 的状态`;
    case 'owner_changed':
      return `房主变更为 ${data.newOwnerName || data.newOwnerId}`;
    case 'sfu_media_forward':
      return `${data.senderName || data.senderId} 发送 ${data.packetCount} 包 → 转发给 ${data.totalReceivers} 人，共 ${data.totalForwardedPackets} 次`;
    default:
      return `${type}: ${JSON.stringify(data)}`;
  }
}

function getFilteredEvents() {
  let events = state.roomEvents.slice();

  const memberFilter = document.getElementById('eventFilterMember');
  const typeFilter = document.getElementById('eventFilterType');
  const timeFilter = document.getElementById('eventFilterTime');

  const memberVal = memberFilter ? memberFilter.value : '';
  const typeVal = typeFilter ? typeFilter.value : '';
  const timeVal = timeFilter ? parseInt(timeFilter.value) : 0;

  if (memberVal) {
    events = events.filter(e => 
      e.clientId === memberVal || 
      e.senderId === memberVal || 
      e.by === memberVal ||
      e.targetClientId === memberVal ||
      e.previousOwnerId === memberVal ||
      e.newOwnerId === memberVal ||
      e.publisherId === memberVal
    );
  }

  if (typeVal) {
    events = events.filter(e => e.type === typeVal);
  }

  if (timeVal > 0) {
    const cutoff = Date.now() - timeVal * 60 * 1000;
    events = events.filter(e => e.timestamp > cutoff);
  }

  return events;
}

function clearEventFilters() {
  const memberFilter = document.getElementById('eventFilterMember');
  const typeFilter = document.getElementById('eventFilterType');
  const timeFilter = document.getElementById('eventFilterTime');
  if (memberFilter) memberFilter.value = '';
  if (typeFilter) typeFilter.value = '';
  if (timeFilter) timeFilter.value = '';
  renderRoomEvents();
}

function showEventSnapshot(event) {
  const modal = document.getElementById('eventSnapshotModal');
  const content = document.getElementById('eventSnapshotContent');
  if (!modal || !content) return;

  let html = '';
  html += `<div style="margin-bottom:16px; padding:12px; background:rgba(79,172,254,0.1); border-radius:8px;">
    <div style="font-weight:600; color:#4facfe; margin-bottom:4px;">${formatRoomEventDescription(event)}</div>
    <div style="font-size:11px; color:#8892b0;">事件ID: ${event.id} | ${new Date(event.timestamp).toLocaleString('zh-CN', { hour12: false })}</div>
  </div>`;

  if (event.snapshot) {
    html += `<div style="font-weight:600; margin-bottom:8px; color:#ccd6f6;">📊 当时房间状态快照:</div>`;
    
    html += `<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:8px; margin-bottom:16px;">`;
    event.snapshot.peers.forEach(peer => {
      const connStates = Object.values(peer.connectionStates || {});
      const iceStates = Object.values(peer.iceStates || {});
      const connectedCount = connStates.filter(s => s === 'connected' || s === 'completed').length;
      const iceConnectedCount = iceStates.filter(s => s === 'connected' || s === 'completed').length;
      
      html += `
        <div style="padding:10px; background:rgba(0,0,0,0.2); border-radius:8px; border-left:3px solid ${peer.isOwner ? '#fbbf24' : '#4facfe'};">
          <div style="font-weight:600; margin-bottom:4px;">${peer.displayName || peer.clientId}${peer.isOwner ? ' 👑' : ''}</div>
          <div style="font-size:10px; color:#8892b0; margin-bottom:6px;">${peer.clientId}</div>
          <div style="font-size:11px;">
            <div>连接: ${connectedCount}/${connStates.length} 已连接</div>
            <div>ICE: ${iceConnectedCount}/${iceStates.length} 已连接</div>
            <div>媒体轨: ${peer.trackCount ? peer.trackCount.total : 0}</div>
            <div>最后信令: ${peer.lastSignalingAt ? formatTimeAgo(peer.lastSignalingAt) : '—'}</div>
          </div>
        </div>
      `;
    });
    html += `</div>`;

    if (event.snapshot.sfuStats) {
      html += `<div style="font-weight:600; margin-bottom:8px; color:#ccd6f6;">📦 SFU 统计:</div>`;
      html += `<div style="padding:10px; background:rgba(0,0,0,0.2); border-radius:8px; font-size:11px;">
        <div>总转发包数: ${event.snapshot.sfuStats.totalPacketsForwarded || 0}</div>
        <div>总转发字节: ${formatBytes(event.snapshot.sfuStats.totalBytesForwarded || 0)}</div>
        <div>活跃发布者: ${event.snapshot.sfuStats.activePublishers || 0}</div>
        <div>活跃订阅者: ${event.snapshot.sfuStats.activeSubscribers || 0}</div>
        <div>总路由数: ${event.snapshot.sfuStats.totalRoutes || 0}</div>
      </div>`;
    }
  } else {
    html += `<div style="color:#8892b0; font-style:italic;">此事件未保存状态快照</div>`;
  }

  content.innerHTML = html;
  modal.classList.remove('hidden');
}

function closeEventSnapshot() {
  const modal = document.getElementById('eventSnapshotModal');
  if (modal) modal.classList.add('hidden');
}

function renderRoomEvents() {
  const panel = document.getElementById('roomEventsPanel');
  if (!panel) return;

  const events = getFilteredEvents();

  if (events.length === 0) {
    panel.innerHTML = '<div style="color:#8892b0;">暂无匹配的事件</div>';
    return;
  }

  const eventTypeIcons = {
    'peer_joined': '➕',
    'peer_reconnect': '🔄',
    'peer_left': '➖',
    'owner_kick': '🚫',
    'owner_transfer': '👑',
    'owner_resync_all': '🔄',
    'owner_force_reconnect': '🔄',
    'owner_rebuild_subscription': '📡',
    'owner_clear_state': '🧹',
    'owner_changed': '👑',
    'sfu_media_forward': '📦'
  };

  let html = '';
  events.slice().reverse().forEach(event => {
    const icon = eventTypeIcons[event.type] || '📋';
    const desc = formatRoomEventDescription(event);
    const time = new Date(event.timestamp).toLocaleString('zh-CN', { hour12: false });
    const hasSnapshot = event.snapshot ? '有快照' : '';
    html += `
      <div class="room-event-item ${event.type}" onclick='showEventSnapshot(${JSON.stringify(event).replace(/'/g, "\\'")})' style="cursor:pointer;">
        <div class="event-time">${time} ${hasSnapshot ? '<span style="color:#4facfe;">📷</span>' : ''}</div>
        <div class="event-type">${icon} ${event.type.replace(/_/g, ' ').toUpperCase()}</div>
        <div class="event-desc">${desc}</div>
      </div>
    `;
  });

  panel.innerHTML = html;
}

let pendingExport = false;

function exportDiagnostics() {
  if (!state.isOwner) {
    alert('只有房主可以导出诊断信息');
    return;
  }
  
  pendingExport = true;
  log('info', '正在获取最新诊断数据...');
  sendWS({ type: 'get_room_info' });
  
  setTimeout(() => {
    if (pendingExport) {
      pendingExport = false;
      doExportDiagnostics();
    }
  }, 1000);
}

function doExportDiagnostics() {
  if (!state.lastRoomInfo) {
    alert('暂无诊断数据可导出');
    return;
  }

  const exportData = {
    exportTime: new Date().toISOString(),
    roomId: state.roomId,
    roomMode: state.mode,
    ownerId: state.ownerId,
    exporter: {
      clientId: state.clientId,
      displayName: state.displayName
    },
    peers: state.lastRoomInfo.peers.map(peer => ({
      clientId: peer.clientId,
      displayName: peer.displayName,
      isOwner: peer.isOwner,
      joinedAt: peer.joinedAt ? new Date(peer.joinedAt).toISOString() : null,
      lastSignalingAt: peer.lastSignalingAt ? new Date(peer.lastSignalingAt).toISOString() : null,
      connectionStates: peer.connectionStates,
      iceStates: peer.iceStates,
      trackCount: peer.trackCount,
      publishedTracks: peer.publishedTracks,
      subscribedTo: peer.subscribedTo,
      recentEvents: peer.recentEvents || [],
      sfuMediaStats: peer.sfuMediaStats
    })),
    sfuStats: state.lastRoomInfo.sfuStats,
    roomEvents: state.roomEvents.slice(-100),
    summary: {
      totalPeers: state.lastRoomInfo.peers.length,
      connectedPeers: state.lastRoomInfo.peers.filter(p => 
        p.connectionStates && Object.values(p.connectionStates).some(s => s === 'connected' || s === 'completed')
      ).length,
      totalPacketsForwarded: state.lastRoomInfo.sfuStats ? state.lastRoomInfo.sfuStats.totalPacketsForwarded : 0,
      eventsInLastHour: state.roomEvents.filter(e => Date.now() - e.timestamp < 3600000).length
    }
  };

  const jsonStr = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `webrtc-diagnostic-${state.roomId}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  log('success', `诊断信息已导出: ${a.download}`);
}

function formatNumber(n) {
  if (n == null) return '0';
  if (n >= 1000000) return (n/1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n/1000).toFixed(1) + 'K';
  return n.toString();
}

function formatBytes(n) {
  if (n == null) return '0 B';
  if (n >= 1024 * 1024) return (n / (1024*1024)).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

window.addEventListener('beforeunload', () => {
  if (state.joined) {
    try { sendWS({ type: 'leave' }); } catch (e) {}
  }
});

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const memberFilter = document.getElementById('eventFilterMember');
    const typeFilter = document.getElementById('eventFilterType');
    const timeFilter = document.getElementById('eventFilterTime');
    
    if (memberFilter) memberFilter.addEventListener('change', renderRoomEvents);
    if (typeFilter) typeFilter.addEventListener('change', renderRoomEvents);
    if (timeFilter) timeFilter.addEventListener('change', renderRoomEvents);
  }, 100);
});
