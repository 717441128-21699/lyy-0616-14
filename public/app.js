const state = {
  ws: null,
  clientId: null,
  roomId: null,
  mode: 'sfu',
  displayName: '',
  joined: false,
  localStream: null,
  audioEnabled: true,
  videoEnabled: true,
  peers: new Map(),
  sfuMediaSeq: 1,
  lastSfuStats: null,
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
  while (panel.children.length > 200) panel.removeChild(panel.firstChild);
}

async function joinRoom() {
  const roomId = document.getElementById('roomIdInput').value.trim();
  const name = document.getElementById('nameInput').value.trim() || `用户${Math.floor(Math.random()*9000)+1000}`;
  if (!roomId) { alert('请输入房间号'); return; }

  state.roomId = roomId;
  state.displayName = name;

  try {
    await initLocalMedia();
  } catch (e) {
    log('error', '获取媒体设备失败: ' + e.message);
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    log('info', 'WebSocket 已连接');
    sendWS({ type: 'join', roomId, displayName: name, mode: state.mode });
  };

  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleSignalingMessage(msg);
    } catch (e) {
      console.error('消息解析失败', e);
    }
  };

  state.ws.onclose = () => {
    log('warn', 'WebSocket 已断开');
    if (state.joined) {
      setTimeout(() => {
        if (!state.joined) return;
        log('warn', '尝试重连 WebSocket...');
        const reconnectProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const reconnectUrl = `${reconnectProtocol}//${location.host}`;
        const newWs = new WebSocket(reconnectUrl);
        newWs.onopen = () => {
          log('success', 'WebSocket 重连成功');
          state.ws = newWs;
          sendWS({ type: 'join', roomId: state.roomId, displayName: state.displayName, mode: state.mode });
        };
        state.ws = newWs;
      }, 2000);
    }
  };

  state.ws.onerror = () => log('error', 'WebSocket 错误');
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
    case 'connection_state':
      handleConnectionState(msg);
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
      updateStatusPanel(msg);
      break;
    case 'error':
      log('error', `错误 [${msg.code}]: ${msg.message}`);
      break;
    case 'pong':
      break;
    default:
      log('warn', `未知消息类型: ${msg.type}`);
  }
}

function handleJoined(msg) {
  state.clientId = msg.clientId;
  state.joined = true;

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
  updateSfuSeqBadge();

  log('success', `已加入房间，ID=${msg.clientId}，模式=${msg.mode.toUpperCase()}`);

  if (msg.peers && msg.peers.length > 0) {
    log('info', `房间内已有 ${msg.peers.length} 人，自动建立连接...`);
    for (const peer of msg.peers) {
      state.peers.set(peer.clientId, { displayName: peer.displayName });
      const grid = document.getElementById('videoGrid');
      if (!document.getElementById(`video-${peer.clientId}`)) {
        const card = createVideoCard(peer.clientId, peer.displayName);
        grid.appendChild(card);
      }
    }
    updateParticipantsList();
    updateConnectionState('local', 'connected');

    msg.peers.forEach(peer => initiateConnection(peer.clientId, true));
  } else {
    updateConnectionState('local', 'connected');
  }

  setTimeout(() => startPublishing(), 500);

  setInterval(() => {
    if (state.joined) sendWS({ type: 'get_room_info' });
  }, 4000);
}

function handlePeerJoined(msg) {
  const { clientId, displayName } = msg;
  if (clientId === state.clientId) return;

  log('info', `新成员加入: ${displayName} (${clientId})`);

  if (!state.peers.has(clientId)) {
    state.peers.set(clientId, { displayName });
  } else {
    const p = state.peers.get(clientId);
    p.displayName = displayName;
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

  if (msg.sfuStats) {
    state.lastSfuStats = msg.sfuStats;
    updateStatusPanel();
    log('info', `SFU 统计已更新: 活跃路由=${msg.sfuStats.activeRoutes}, 已转发包=${formatNumber(msg.sfuStats.totalPacketsForwarded)}`);
  }
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

function handleConnectionState(msg) {
  const { from, state: connState } = msg;
  updateConnectionState(from, connState);
}

function getOrCreatePeer(peerId) {
  let peer = state.peers.get(peerId);
  if (peer && peer.pc && peer.pc.connectionState !== 'closed' && peer.pc.connectionState !== 'failed') {
    return peer;
  }
  if (!peer) peer = { displayName: peerId };
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
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    log('info', `连接状态 [${peerId}]: ${s}`);
    updateConnectionState(peerId, s);
    sendWS({ type: 'connection_state', peerId, state: s });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
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

  peer.pc = pc;
  peer.stream = peer.stream || null;
  peer.tracksAdded = false;
  state.peers.set(peerId, peer);
  return peer;
}

function initiateConnection(peerId, isInitiator) {
  const peer = getOrCreatePeer(peerId);
  const pc = peer.pc;

  if (state.localStream && !peer.tracksAdded) {
    state.localStream.getTracks().forEach(track => {
      try { pc.addTrack(track, state.localStream); } catch (e) {}
    });
    peer.tracksAdded = true;
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
  state.sfuMediaSeq += count;
  updateSfuSeqBadge();
}

function updateSfuSeqBadge() {
  const el = document.getElementById('sfuSeqBadge');
  if (el) el.textContent = `当前 Seq: ${state.sfuMediaSeq}`;
}

function handleSfuMediaPacket(msg) {
  const { from, trackId, kind, seq, size, ts } = msg;
  log('success', `收到 SFU 转发媒体包: 来自=${from}, track=${trackId}, kind=${kind}, seq=${seq}, size=${size}B`);
}

function handleSfuMediaAck(msg) {
  const { trackId, count, forwardedTo, sfuStats } = msg;
  log('success', `SFU 转发确认: track=${trackId}, 包数=${count}, 转发给 ${forwardedTo} 人`);
  if (sfuStats) {
    state.lastSfuStats = sfuStats;
    updateStatusPanel();
  }
}

function handleSfuMediaStatsUpdate(msg) {
  const { publisherId, lastSeq, sfuStats } = msg;
  log('info', `SFU 转发统计更新: ${publisherId} 最新 seq=${lastSeq}, 总路由=${sfuStats.activeRoutes}`);
  if (sfuStats) {
    state.lastSfuStats = sfuStats;
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
  } catch (e) {
    log('error', `切换摄像头失败: ${e.message}`);
  }
}

function leaveRoom() {
  sendWS({ type: 'leave' });
  state.joined = false;

  for (const [peerId, peer] of state.peers) {
    if (peer.pc) { try { peer.pc.close(); } catch (e) {} }
  }
  state.peers.clear();
  state.sfuMediaSeq = 1;
  state.lastSfuStats = null;

  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }

  if (state.ws) {
    try { state.ws.close(); } catch (e) {}
    state.ws = null;
  }

  document.getElementById('roomSection').classList.add('hidden');
  document.getElementById('loginSection').classList.remove('hidden');
  document.getElementById('videoGrid').innerHTML = '';
  document.getElementById('participantsList').innerHTML = '';
  document.getElementById('chatMessages').innerHTML = '';
  document.getElementById('logPanel').innerHTML = '';
  document.getElementById('statusPanel').innerHTML = '';
  document.getElementById('roomIdInput').value = state.roomId || '';
}

function updateParticipantsList() {
  const list = document.getElementById('participantsList');
  const countEl = document.getElementById('participantCount');
  if (!list) return;
  list.innerHTML = '';
  const items = [{
    id: state.clientId,
    name: state.displayName || '我',
    isLocal: true
  }];
  for (const [id, peer] of state.peers) {
    items.push({ id, name: peer.displayName || id, isLocal: false });
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
          <div style="font-weight:600;">${item.name}${item.isLocal ? ' (我)' : ''}</div>
          <div style="font-size:11px;color:#8892b0;">${item.id || ''}</div>
        </div>
      </div>
    `;
    list.appendChild(div);
  });
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
