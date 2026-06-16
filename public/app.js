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
  sfuSubscriptions: new Map(),
  sfuPublishedTracks: [],
  sfuSendPc: null,
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
  if (panel.children.length > 100) panel.removeChild(panel.firstChild);
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
    sendWS({ type: 'join', roomId, displayName: name });
  };

  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleSignalingMessage(msg);
    } catch (e) {
      console.error('消息解析失败', e);
    }
  };

  state.ws.onclose = () => log('warn', 'WebSocket 已断开');
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
  placeholder.style.display = 'none';
  placeholder.innerHTML = `
    <div class="avatar">${(name || '?').charAt(0).toUpperCase()}</div>
    <div style="font-size:14px;color:#a8b2d1;">${name}</div>
  `;

  const indicator = document.createElement('div');
  indicator.className = 'video-indicator';
  indicator.innerHTML = `
    <div class="indicator-dot" id="audio-ind-${id}">🎤</div>
    <div class="indicator-dot" id="video-ind-${id}">📷</div>
  `;

  const label = document.createElement('div');
  label.className = `video-label ${isLocal ? 'local' : ''}`;
  label.textContent = name + (isLocal ? ' (我)' : '');

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
    case 'sfu_route_info':
      log('info', `SFU 路由信息已收到: 发布者=${msg.routes.incomingPublishers.length}, 订阅者=${msg.routes.outgoingSubscribers.length}`);
      break;
    case 'sfu_available_track':
      handleSfuAvailableTrack(msg);
      break;
    case 'sfu_track_removed':
      handleSfuTrackRemoved(msg);
      break;
    case 'sfu_media_packet':
      handleSfuMediaPacket(msg);
      break;
    case 'sfu_publish_ok':
      log('success', 'SFU 发布成功');
      break;
    case 'sfu_subscribe_ok':
      log('info', `SFU 订阅成功: ${msg.publisherId} - ${msg.trackId}`);
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

  log('success', `已加入房间，ID=${msg.clientId}`);

  if (msg.peers && msg.peers.length > 0) {
    log('info', `房间内已有 ${msg.peers.length} 人`);
    for (const peer of msg.peers) {
      state.peers.set(peer.clientId, { displayName: peer.displayName });
      const grid = document.getElementById('videoGrid');
      const card = createVideoCard(peer.clientId, peer.displayName);
      grid.appendChild(card);
    }
    updateParticipantsList();

    if (state.mode === 'mesh') {
      msg.peers.forEach(peer => initiateMeshConnection(peer.clientId, true));
    } else {
      msg.peers.forEach(peer => {
        setTimeout(() => {
          sendWS({
            type: 'sfu_subscribe',
            publisherId: peer.clientId,
            trackId: `video-${peer.clientId}`,
            kind: 'video'
          });
          sendWS({
            type: 'sfu_subscribe',
            publisherId: peer.clientId,
            trackId: `audio-${peer.clientId}`,
            kind: 'audio'
          });
          createSfuReceiveConnection(peer.clientId);
        }, 300);
      });
    }
  }

  setTimeout(() => startPublishing(), 500);

  setInterval(() => {
    if (state.joined) sendWS({ type: 'get_room_info' });
  }, 5000);
}

function handlePeerJoined(msg) {
  log('info', `新成员加入: ${msg.displayName} (${msg.clientId})`);
  state.peers.set(msg.clientId, { displayName: msg.displayName });

  const grid = document.getElementById('videoGrid');
  const card = createVideoCard(msg.clientId, msg.displayName);
  grid.appendChild(card);
  updateParticipantsList();

  if (state.mode === 'mesh') {
    initiateMeshConnection(msg.clientId, false);
  } else {
    setTimeout(() => {
      sendWS({
        type: 'sfu_subscribe',
        publisherId: msg.clientId,
        trackId: `video-${msg.clientId}`,
        kind: 'video'
      });
      sendWS({
        type: 'sfu_subscribe',
        publisherId: msg.clientId,
        trackId: `audio-${msg.clientId}`,
        kind: 'audio'
      });
      createSfuReceiveConnection(msg.clientId);
    }, 300);
  }
}

function handlePeerLeft(msg) {
  const id = msg.clientId;
  log('warn', `${msg.displayName || id} 离开了房间 (原因: ${msg.reason || '主动离开'})`);

  const peer = state.peers.get(id);
  if (peer && peer.pc) {
    try { peer.pc.close(); } catch (e) {}
  }
  state.peers.delete(id);

  const sfuRecv = state.sfuSubscriptions.get(id);
  if (sfuRecv && sfuRecv.pc) {
    try { sfuRecv.pc.close(); } catch (e) {}
  }
  state.sfuSubscriptions.delete(id);

  const card = document.getElementById(`video-${id}`);
  if (card) card.remove();

  updateParticipantsList();
}

function handleOffer(msg) {
  if (msg.to) {
    const isRecvOffer = msg.to.endsWith('_recv');
    const isSendOffer = msg.to.endsWith('_send');
    const peerId = msg.from;

    if (state.mode === 'sfu') {
      if (isSendOffer) return;
      if (isRecvOffer) {
        const publisherId = peerId.replace('_recv', '').replace('_send', '');
        const entry = state.sfuSubscriptions.get(publisherId);
        if (!entry) return;
        const pc = entry.pc;
        pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          .then(() => pc.createAnswer())
          .then(answer => pc.setLocalDescription(answer))
          .then(() => {
            sendWS({ type: 'answer', to: peerId, sdp: pc.localDescription });
            log('success', `已发送 SFU 接收 Answer 给 ${publisherId}`);
          })
          .catch(e => log('error', `处理 SFU 接收 Offer 失败: ${e.message}`));
        return;
      }
      if (state.sfuSendPc && peerId === state.clientId + '_send') {
        state.sfuSendPc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          .then(() => log('success', 'SFU 发送通道远程描述已设置'))
          .catch(e => log('error', `SFU 发送设置远程描述失败: ${e.message}`));
        return;
      }
      return;
    }
  }

  if (state.mode !== 'mesh') return;
  log('info', `收到来自 ${msg.from} 的 Offer`);
  const peer = getOrCreatePeer(msg.from);
  peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
    .then(() => peer.pc.createAnswer())
    .then(answer => peer.pc.setLocalDescription(answer))
    .then(() => {
      sendWS({ type: 'answer', to: msg.from, sdp: peer.pc.localDescription });
      log('success', `已发送 Answer 给 ${msg.from}`);
    })
    .catch(e => log('error', `处理 Offer 失败: ${e.message}`));
}

function handleAnswer(msg) {
  if (state.mode === 'sfu') {
    const fromId = msg.from;
    if (fromId.endsWith('_recv') || fromId.endsWith('_send')) {
      const pubId = fromId.replace('_recv', '').replace('_send', '');
      const entry = state.sfuSubscriptions.get(pubId);
      if (entry && entry.pc) {
        entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          .then(() => log('success', `SFU 接收通道 Answer 设置成功 [${pubId}]`))
          .catch(e => log('error', `SFU Answer 设置失败: ${e.message}`));
        return;
      }
      if (state.sfuSendPc) {
        state.sfuSendPc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          .then(() => log('success', 'SFU 发送通道 Answer 设置成功'))
          .catch(e => log('error', `SFU 发送 Answer 设置失败: ${e.message}`));
        return;
      }
      return;
    }
  }

  if (state.mode !== 'mesh') return;
  log('info', `收到来自 ${msg.from} 的 Answer`);
  const peer = state.peers.get(msg.from);
  if (peer && peer.pc) {
    peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
      .catch(e => log('error', `设置远程描述失败: ${e.message}`));
  }
}

function handleIceCandidate(msg) {
  const fromId = msg.from;
  let pc = null;

  if (state.mode === 'sfu') {
    if (fromId.endsWith('_recv') || fromId.endsWith('_send')) {
      const pubId = fromId.replace('_recv', '').replace('_send', '');
      const entry = state.sfuSubscriptions.get(pubId);
      if (entry) pc = entry.pc;
      else if (state.sfuSendPc) pc = state.sfuSendPc;
    } else {
      const entry = state.sfuSubscriptions.get(fromId);
      if (entry) pc = entry.pc;
      else if (state.sfuSendPc) pc = state.sfuSendPc;
    }
  } else {
    const peer = state.peers.get(fromId);
    if (peer) pc = peer.pc;
  }

  if (pc && msg.candidate) {
    pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
      .catch(() => {});
  }
}

function getOrCreatePeer(peerId) {
  let peer = state.peers.get(peerId);
  if (peer && peer.pc) return peer;
  if (!peer) peer = { displayName: peerId };

  const pc = new RTCPeerConnection(state.rtcConfig);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendWS({ type: 'ice_candidate', to: peerId, candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    if (!peer.stream) peer.stream = new MediaStream();
    e.streams[0].getTracks().forEach(t => peer.stream.addTrack(t));
    showVideoTrack(peerId, peer.stream);
    log('success', `收到来自 ${peerId} 的媒体轨: ${e.track.kind}`);
  };

  pc.onconnectionstatechange = () => {
    log('info', `连接状态 [${peerId}]: ${pc.connectionState}`);
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      log('warn', `ICE 连接异常 [${peerId}]: ${pc.iceConnectionState}`);
    }
  };

  peer.pc = pc;
  peer.stream = null;
  state.peers.set(peerId, peer);
  return peer;
}

function initiateMeshConnection(peerId, isInitiator) {
  const peer = getOrCreatePeer(peerId);
  const pc = peer.pc;

  if (state.localStream) {
    state.localStream.getTracks().forEach(track => {
      pc.addTrack(track, state.localStream);
    });
  }

  if (isInitiator) {
    setTimeout(() => {
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
          sendWS({ type: 'offer', to: peerId, sdp: pc.localDescription });
          log('info', `已发送 Offer 给 ${peerId}`);
        })
        .catch(e => log('error', `创建 Offer 失败: ${e.message}`));
    }, 200);
  }
}

function startPublishing() {
  if (state.mode === 'sfu') {
    createSfuSendConnection();
  }
}

function createSfuSendConnection() {
  const pc = new RTCPeerConnection(state.rtcConfig);
  state.sfuSendPc = pc;

  if (state.localStream) {
    const tracks = [];
    state.localStream.getTracks().forEach(track => {
      pc.addTrack(track, state.localStream);
      const trackId = `${track.kind}-${state.clientId}`;
      tracks.push({ trackId, kind: track.kind });
    });

    state.sfuPublishedTracks = tracks;

    setTimeout(() => {
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
          log('info', `SFU: 本地描述已设置，准备发布 ${tracks.length} 条轨道`);
          sendWS({ type: 'sfu_publish', tracks });

          setTimeout(() => {
            pc.createOffer()
              .then(offer => pc.setLocalDescription(offer))
              .then(() => {
                sendWS({ type: 'offer', to: state.clientId + '_send', sdp: pc.localDescription });
                log('info', `SFU: 发送发布 Offer`);
              });
          }, 100);
        })
        .catch(e => log('error', `SFU 发布失败: ${e.message}`));
    }, 300);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendWS({ type: 'ice_candidate', to: state.clientId + '_send', candidate: e.candidate });
    }
  };

  pc.ontrack = () => {};

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      log('success', 'SFU 发送通道已连接');
    }
  };
}

function createSfuReceiveConnection(publisherId) {
  if (state.sfuSubscriptions.has(publisherId)) return;

  const pc = new RTCPeerConnection(state.rtcConfig);
  const entry = { pc, stream: new MediaStream() };

  pc.ontrack = (e) => {
    e.streams[0].getTracks().forEach(t => {
      if (!entry.stream.getTrackById(t.id)) {
        entry.stream.addTrack(t);
      }
    });
    showVideoTrack(publisherId, entry.stream);
    log('success', `SFU 收到 ${publisherId} 的 ${e.track.kind} 轨道`);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendWS({ type: 'ice_candidate', to: publisherId + '_recv', candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      log('success', `SFU 接收通道已连接 [${publisherId}]`);
    }
  };

  state.sfuSubscriptions.set(publisherId, entry);
}

function handleSfuAvailableTrack(msg) {
  const { publisherId, tracks } = msg;
  log('info', `SFU: ${publisherId} 有 ${tracks.length} 条可用轨道`);
  if (!state.sfuSubscriptions.has(publisherId)) {
    createSfuReceiveConnection(publisherId);
  }
}

function handleSfuTrackRemoved(msg) {
  const { publisherId } = msg;
  log('warn', `SFU: ${publisherId} 的轨道已移除`);
}

function handleSfuMediaPacket(msg) {
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
      if (peer.pc) {
        const senders = peer.pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender) videoSender.replaceTrack(newVideoTrack);
      }
    }

    if (state.sfuSendPc) {
      const senders = state.sfuSendPc.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender) videoSender.replaceTrack(newVideoTrack);
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

  for (const [id, sub] of state.sfuSubscriptions) {
    if (sub.pc) { try { sub.pc.close(); } catch (e) {} }
  }
  state.sfuSubscriptions.clear();

  if (state.sfuSendPc) {
    try { state.sfuSendPc.close(); } catch (e) {}
    state.sfuSendPc = null;
  }

  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }

  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }

  document.getElementById('roomSection').classList.add('hidden');
  document.getElementById('loginSection').classList.remove('hidden');
  document.getElementById('videoGrid').innerHTML = '';
  document.getElementById('participantsList').innerHTML = '';
  document.getElementById('chatMessages').innerHTML = '';
  document.getElementById('logPanel').innerHTML = '';
}

function updateParticipantsList() {
  const list = document.getElementById('participantsList');
  const countEl = document.getElementById('participantCount');
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
          <div style="font-size:11px;color:#8892b0;">${item.id}</div>
        </div>
      </div>
    `;
    list.appendChild(div);
  });
}

function updateStatusPanel(msg) {
  const panel = document.getElementById('statusPanel');
  if (!panel || !msg) return;
  const { peers, sfuStats } = msg;
  const myPublished = state.sfuPublishedTracks.length || 0;
  const mySubscriptions = state.sfuSubscriptions.size;

  let extraHtml = '';
  if (state.mode === 'sfu') {
    extraHtml = `
      <div class="status-item">
        <div class="label">SFU活跃路由</div>
        <div class="value">${sfuStats ? sfuStats.activeRoutes : 0}</div>
      </div>
      <div class="status-item">
        <div class="label">SFU转发包数</div>
        <div class="value">${sfuStats ? formatNumber(sfuStats.totalPacketsForwarded) : 0}</div>
      </div>
    `;
  }

  panel.innerHTML = `
    <div class="status-item">
      <div class="label">房间人数</div>
      <div class="value">${peers.length}</div>
    </div>
    <div class="status-item">
      <div class="label">连接模式</div>
      <div class="value">${state.mode.toUpperCase()}</div>
    </div>
    <div class="status-item">
      <div class="label">已发布轨道</div>
      <div class="value">${state.mode === 'sfu' ? myPublished : '—'}</div>
    </div>
    <div class="status-item">
      <div class="label">${state.mode === 'sfu' ? '订阅发布者' : 'P2P连接数'}</div>
      <div class="value">${state.mode === 'sfu' ? mySubscriptions : state.peers.size}</div>
    </div>
    ${extraHtml}
  `;
}

function formatNumber(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1)+'M';
  if (n >= 1000) return (n/1000).toFixed(1)+'K';
  return n;
}

window.addEventListener('beforeunload', () => {
  if (state.joined) leaveRoom();
});
