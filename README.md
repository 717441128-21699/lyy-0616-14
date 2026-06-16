# WebRTC 信令服务器 + SFU 媒体转发雏形

## 项目概述

本项目实现了一个完整的 WebRTC 多人音视频通话系统雏形，包含：

- **信令服务器**：基于 WebSocket，负责房间管理、SDP 交换、ICE 候选转发
- **SFU 媒体转发模块**：选择性转发单元，管理媒体路由（简化的数据包转发层）
- **前端客户端**：支持 **Mesh 网状直连** 和 **SFU 转发** 两种模式切换

## 快速开始

```bash
npm install
npm start
# 打开 http://localhost:8080
```

打开多个浏览器标签页（或不同设备/浏览器），输入相同的房间号即可加入通话。

---

## 项目结构

```
├── server/
│   ├── index.js          # 入口：WebSocket 信令服务 + Express 静态服务
│   ├── RoomManager.js    # 房间管理：加入/离开/广播/成员列表
│   └── SFU.js            # SFU 转发路由：发布订阅、数据包转发、统计
├── public/
│   ├── index.html        # 前端 UI：登录/视频网格/聊天/状态面板
│   └── app.js            # 前端逻辑：Mesh & SFU 两种模式的 WebRTC 建立
└── package.json
```

核心文件：
- [server/index.js](file:///d:/trae-bz/TraeProjects/14/server/index.js) — 信令服务器主逻辑
- [server/RoomManager.js](file:///d:/trae-bz/TraeProjects/14/server/RoomManager.js) — 房间管理器
- [server/SFU.js](file:///d:/trae-bz/TraeProjects/14/server/SFU.js) — SFU 转发路由
- [public/app.js](file:///d:/trae-bz/TraeProjects/14/public/app.js) — 客户端 WebRTC 逻辑

---

## 核心设计详解

---

### 一、信令如何协调 N 个客户端建立连接

#### 1.1 信令消息类型总览

| 消息类型 | 方向 | 用途 |
|---------|------|------|
| `join` | C→S | 加入房间，携带 roomId 和 displayName |
| `joined` | S→C | 加入成功，返回 clientId 和现有 peers 列表 |
| `peer_joined` | S→(其他C) | 广播：有新人加入 |
| `peer_left` | S→(其他C) | 广播：有人离开 |
| `offer` | C→S→C | 交换 SDP Offer（发起方描述能力） |
| `answer` | C→S→C | 交换 SDP Answer（应答方描述能力） |
| `ice_candidate` | C→S→C | 交换 ICE 网络候选地址 |
| `sfu_publish` / `sfu_subscribe` | C→S | SFU 模式下的发布/订阅 |
| `sfu_media_packet` | S→C | SFU 转发的媒体数据包 |
| `chat` | C→S→C | 房间内文字消息广播 |

#### 1.2 Mesh 模式（两两直连）

```
客户端 A ←─P2P──→ 客户端 B
    ↑                 ↑
    └─────P2P──────→ 客户端 C
```

**建立流程（N=3 人：A、B 已在房间，C 新加入）：**

1. **C 发送 `join`** → 服务器返回 `joined`，附带 `peers: [A, B]`
2. **服务器广播 `peer_joined`** 给 A 和 B
3. **C 作为发起方（isInitiator=true）**：
   - C 对 A：创建 RTCPeerConnection → addTrack → createOffer → 发送 `offer` 给 A
   - C 对 B：创建 RTCPeerConnection → addTrack → createOffer → 发送 `offer` 给 B
4. **A/B 作为应答方**：
   - A 收到 `offer` → setRemoteDescription → createAnswer → 发送 `answer` 给 C
   - B 收到 `offer` → setRemoteDescription → createAnswer → 发送 `answer` 给 C
5. **ICE 候选交互**：双方的 `onicecandidate` 事件触发，通过 `ice_candidate` 消息交换网络地址
6. **ICE 连通性检查**：双方尝试建立 P2P 直连（STUN 打洞，必要时走 TURN 中继）
7. **`ontrack` 事件**：媒体轨到达，显示远程视频

**连接数公式**：N 人 Mesh 需要 **N × (N-1) / 2** 条 PeerConnection

| 人数 | PeerConnection 数 | 每人需维护连接数 |
|-----|------------------|----------------|
| 2   | 1                | 1              |
| 3   | 3                | 2              |
| 4   | 6                | 3              |
| 5   | 10               | 4              |
| 10  | 45               | 9              |
| 100 | 4950             | 99             | ← 爆炸增长！

#### 1.3 SFU 模式（服务器转发）

```
客户端 A ──上行──→ ┌──────────┐ ──下行──→ 客户端 B
                   │   SFU    │
客户端 C ──上行──→ │  服务器  │ ──下行──→ 客户端 D
                   └──────────┘ ──下行──→ ...
```

**每个客户端只需：**
- **1 条上行 PeerConnection**（发送自己的音视频到 SFU）
- **N-1 条下行 PeerConnection**（接收其他人的流）
- **总共维护 N 条连接**（而不是 N-1 条 P2P）

**SFU 的虚拟端点设计：**
- `${clientId}_send` — 客户端向 SFU 发送媒体的上行通道
- `${publisherId}_recv` — 客户端从 SFU 接收某发布者媒体的下行通道

服务器端 [handleOffer](file:///d:/trae-bz/TraeProjects/14/server/index.js#L220-L248) 会识别 `_send`/`_recv` 后缀，剥掉后缀后找到真正的客户端 WebSocket 转发 SDP。

**建立流程（C 加入已有 A、B 的房间）：**

1. C 加入，获得 `peers: [A, B]`
2. C 创建 **1 个上行 PC**（sfuSendPc）：
   - addTrack(本地音视频) → createOffer → 发送 `offer`，`to = C_id + "_send"`
   - 服务器剥掉 `_send` → 找到真正的订阅者并转发 SDP/ICE
3. C 对 A、B 各创建 **1 个下行 PC**（sfuRecvPc）：
   - createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true })
   - 发送 `offer`，`to = "A_id" + "_recv"` 和 `to = "B_id" + "_recv"`
4. SFU 模块在 [setupFullMeshRoutes](file:///d:/trae-bz/TraeProjects/14/server/SFU.js#L108-L130) 中建立 4 条路由：
   ```
   A → C (audio), A → C (video)
   B → C (audio), B → C (video)
   C → A (audio), C → A (video)  [通知 A 订阅 C]
   C → B (audio), C → B (video)  [通知 B 订阅 C]
   ```

---

### 二、为什么 SFU 比 Mesh 更适合多人？

#### 2.1 连接复杂度对比

| 维度 | Mesh (N 人) | SFU (N 人) |
|------|------------|-----------|
| **PeerConnection 总数** | O(N²) = N(N-1)/2 | O(N) = 2N-1 |
| **每人上行带宽消耗** | 720p 视频 ~1.5 Mbps × (N-1) | 720p 视频 ~1.5 Mbps × 1 |
| **每人下行带宽消耗** | 720p 视频 ~1.5 Mbps × (N-1) | 720p 视频 ~1.5 Mbps × (N-1) |
| **每人 CPU 编解码** | N-1 路编码 + N-1 路解码 | 1 路编码 + N-1 路解码 |
| **10 人时总带宽(服务端)** | 0（纯 P2P） | ~27 Mbps 入 + ~27 Mbps 出 |

#### 2.2 上行带宽：Mesh 的致命瓶颈

**以 10 人会议、720p 视频（~1.5 Mbps）为例：**

- **Mesh 模式**：每台客户端需要向其他 9 人**各上传一份**自己的视频
  - 上行带宽需求：1.5 Mbps × 9 = **13.5 Mbps** ← 多数家用网络上行只有 5-20 Mbps，已经接近极限
  - 如果再加上屏幕共享（~5 Mbps）：5 Mbps × 9 = 45 Mbps，**完全无法承载**

- **SFU 模式**：每台客户端**只上传一份**给服务器
  - 上行带宽需求：1.5 Mbps × 1 = **1.5 Mbps** ← 即使加上屏幕共享也才 6.5 Mbps，轻松承载

#### 2.3 连接数：Mesh 的 CPU/内存爆炸

- **10 人 Mesh**：每人维护 9 个 RTCPeerConnection，共 45 个连接全局
- **10 人 SFU**：每人维护 1+9=10 个 PC，但**编解码工作量少了 9 倍**
- **100 人 Mesh**：99 条连接 → 浏览器崩溃
- **100 人 SFU**：配合 SVC/Simulcast，选择性订阅感兴趣的视频流即可

#### 2.4 其他 SFU 优势

- **选择性转发**：可以只订阅说话人的大视频、其他人的小视频或不订阅（节省下行）
- **Simulcast/SVC 支持**：客户端发送多路分辨率，SFU 根据网络情况给不同订阅者不同质量
- **录制/转码**：集中在服务器做录制、AI 分析、直播推流
- **隐私控制**：媒体经过服务器，可以做内容审查、水印
- **防火墙友好**：所有媒体走服务器出端口 443，无需 P2P 打洞（STUN/TURN 需求降低）

---

### 三、新人加入房间的完整流程

#### 3.1 时序图（SFU 模式）

```
新人 Client_C                信令服务器+SFU              Client_A, Client_B
     │                            │                          │
     │ 1. WebSocket 连接           │                          │
     │───────────────────────────→│                          │
     │                            │                          │
     │ 2. join(roomId, name)      │                          │
     │───────────────────────────→│                          │
     │                            │ 3. 注册 C 到 SFU          │
     │                            │    建立路由 A→C, B→C      │
     │                            │    建立路由 C→A, C→B      │
     │                            │                          │
     │ 4. joined(peers:[A,B])     │                          │
     │←───────────────────────────│                          │
     │                            │                          │
     │                            │ 5. peer_joined(C) 广播    │
     │                            │─────────────────────────→│
     │                            │                          │
     │ 6. 创建上行PC(send)         │                          │
     │    + addTrack(本地AV)       │                          │
     │                            │                          │
     │ 7. offer(to=C_send)        │                          │
     │───────────────────────────→│                          │
     │                            │ 8. 剥_send→转发给各订阅者  │
     │                            │──────────────(answer)────→│
     │←───────────────────────────│                          │
     │                            │←─────────────────────────│
     │ 9. ice_candidate 交换      │                          │
     │<══════════════════════════>│<════════════════════════>│
     │                            │                          │
     │ 10. 对 A 创建下行PC(recv)   │                          │
     │     offer(to=A_recv)       │                          │
     │───────────────────────────→│                          │
     │                            │ 转发给 A 的上行通道应答    │
     │                            │                          │
     │ 11. 对 B 创建下行PC(recv)   │                          │
     │     offer(to=B_recv)       │                          │
     │───────────────────────────→│                          │
     │                            │                          │
     │ 12. ontrack 收到 A/B 媒体   │                          │
     │     ↓ 显示视频              │                          │
     │                            │                          │
     │ 13. A/B 端创建对 C 的下行   │                          │
     │     接收 C 的媒体并显示      │                          │
```

#### 3.2 关键代码位置

| 阶段 | 服务端代码 | 客户端代码 |
|-----|-----------|-----------|
| 加入房间 | [handleJoin](file:///d:/trae-bz/TraeProjects/14/server/index.js#L116-L193) | [handleJoined](file:///d:/trae-bz/TraeProjects/14/public/app.js#L224-L275) |
| SFU 路由建立 | [setupFullMeshRoutes](file:///d:/trae-bz/TraeProjects/14/server/SFU.js#L108-L130) | [createSfuSendConnection](file:///d:/trae-bz/TraeProjects/14/public/app.js#L497-L544) |
| Mesh 发起连接 | - | [initiateMeshConnection](file:///d:/trae-bz/TraeProjects/14/public/app.js#L468-L489) |
| 新人广播 | [handleJoin L161-166](file:///d:/trae-bz/TraeProjects/14/server/index.js#L161-L166) | [handlePeerJoined](file:///d:/trae-bz/TraeProjects/14/public/app.js#L277-L305) |
| SDP Offer 转发 | [handleOffer](file:///d:/trae-bz/TraeProjects/14/server/index.js#L220-L248) | [handleOffer](file:///d:/trae-bz/TraeProjects/14/public/app.js#L329-L373) |
| ICE 转发 | [handleIceCandidate](file:///d:/trae-bz/TraeProjects/14/server/index.js#L280-L308) | [handleIceCandidate](file:///d:/trae-bz/TraeProjects/14/public/app.js#L406-L430) |

---

### 四、客户端断开的通知与清理流程

#### 4.1 三种断开场景

| 场景 | 触发方式 | 清理机制 |
|------|---------|---------|
| **主动退出** | 点击「退出房间」按钮发送 `leave` | 立即清理 |
| **WebSocket 断开** | 关闭标签页、网络中断 | `ws.on('close')` 立即清理 |
| **心跳超时** | 客户端网络挂起但 TCP 未断 | 30 秒 ping/pong 超时后清理 |

#### 4.2 清理流程详解（以 Client_B 断开为例）

```
Client_B (断开)        信令服务器+SFU           Client_A, Client_C
     │                      │                         │
     │─── WS close/tout ──→│                         │
     │                      │                         │
     │                      │ 1. RoomManager          │
     │                      │    .leaveRoom(room, B)  │
     │                      │    从房间 Map 删除 B     │
     │                      │    若房间空则销毁房间    │
     │                      │                         │
     │                      │ 2. SFU                  │
     │                      │    .unregisterClient(B) │
     │                      │    遍历 routes:         │
     │                      │      删除所有 B→X 路由   │
     │                      │      删除所有 X→B 路由   │
     │                      │    从 clientStreams 删除 │
     │                      │    清理 others 的        │
     │                      │    outgoingTargets 引用  │
     │                      │                         │
     │                      │ 3. 广播 peer_left(B)    │
     │                      │────────────────────────→│
     │                      │                         │
     │                      │                         │ 4. 客户端收到 peer_left
     │                      │                         │    - pc.close() 关闭连接
     │                      │                         │    - 从 state.peers 删除
     │                      │                         │    - 从 sfuSubscriptions 删除
     │                      │                         │    - 移除视频 DOM 元素
     │                      │                         │    - 更新参与者列表
```

#### 4.3 关键代码位置

| 清理步骤 | 代码位置 |
|---------|---------|
| **服务端 WebSocket close** | [index.js L455-477](file:///d:/trae-bz/TraeProjects/14/server/index.js#L455-L477) — 连接关闭时的清理 |
| **心跳超时清理** | [index.js L484-508](file:///d:/trae-bz/TraeProjects/14/server/index.js#L484-L508) — 30s ping/pong 检测 |
| **RoomManager 离开** | [RoomManager.leaveRoom](file:///d:/trae-bz/TraeProjects/14/server/RoomManager.js#L42-L54) — 从房间移除，空房间销毁 |
| **RoomManager 广播** | [RoomManager.broadcastToRoom](file:///d:/trae-bz/TraeProjects/14/server/RoomManager.js#L71-L78) — 通知其他成员 |
| **SFU 注销清理路由** | [SFU.unregisterClient](file:///d:/trae-bz/TraeProjects/14/server/SFU.js#L142-L162) — 双向路由全量清理 |
| **客户端接收离开通知** | [handlePeerLeft](file:///d:/trae-bz/TraeProjects/14/public/app.js#L307-L327) — 本地清理 PC + DOM |

#### 4.4 SFU 路由清理的关键逻辑

```javascript
// [SFU.js] unregisterClient 核心
for (const [key, route] of this.routes) {
  // 同时清理：
  // 1. senderId === clientId → B 作为发布者的所有出方向路由
  // 2. receiverId === clientId → B 作为订阅者的所有入方向路由
  if (route.senderId === clientId || route.receiverId === clientId) {
    route.active = false;
    this.routes.delete(key);
  }
}
```

这样可以保证：
- 不再有任何数据包被转发到已断开的客户端
- 已断开客户端的媒体源也不会再被路由（防止内存泄漏）
- 其他客户端收到 `peer_left` 后会及时关闭 PC、释放视频资源

---

## 信令消息协议参考

### 加入房间
```json
// Client → Server
{ "type": "join", "roomId": "demo-001", "displayName": "Alice" }

// Server → Client
{
  "type": "joined",
  "clientId": "abc123",
  "roomId": "demo-001",
  "displayName": "Alice",
  "peers": [
    { "clientId": "def456", "displayName": "Bob" }
  ],
  "timestamp": 1718600000000
}

// Server → Others (广播)
{
  "type": "peer_joined",
  "clientId": "abc123",
  "displayName": "Alice",
  "timestamp": 1718600000000
}
```

### SDP 交换 (Mesh)
```json
// 发起方 → Server → 应答方
{
  "type": "offer",
  "to": "def456",
  "from": "abc123",
  "sdp": "v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\n..."
}

// 应答方 → Server → 发起方
{
  "type": "answer",
  "to": "abc123",
  "from": "def456",
  "sdp": "v=0\r\no=- 67890 2 IN IP4 127.0.0.1\r\n..."
}
```

### SDP 交换 (SFU 虚拟端点)
```json
// 发布上行 Offer (C 发给 SFU)
{ "type": "offer", "to": "abc123_send", "from": "abc123", "sdp": "..." }

// 订阅下行 Offer (C 订阅 B 的流)
{ "type": "offer", "to": "def456_recv", "from": "abc123", "sdp": "..." }
```

### ICE 候选
```json
{
  "type": "ice_candidate",
  "to": "def456",
  "from": "abc123",
  "candidate": {
    "candidate": "candidate:1 1 UDP 2130706431 192.168.1.2 55555 typ host",
    "sdpMid": "0",
    "sdpMLineIndex": 0
  }
}
```

### SFU 发布/订阅
```json
// Client → Server (发布轨道)
{
  "type": "sfu_publish",
  "tracks": [
    { "trackId": "audio-abc123", "kind": "audio" },
    { "trackId": "video-abc123", "kind": "video" }
  ]
}

// Server → Subscribers (通知有新轨道)
{
  "type": "sfu_available_track",
  "publisherId": "abc123",
  "tracks": [
    { "trackId": "audio-abc123", "kind": "audio" },
    { "trackId": "video-abc123", "kind": "video" }
  ]
}

// Client → Server (订阅某发布者的轨道)
{
  "type": "sfu_subscribe",
  "publisherId": "def456",
  "trackId": "video-def456",
  "kind": "video"
}
```

---

## 生产环境改进建议

本项目是**教学雏形**，生产环境需要：

1. **真正的媒体层**：使用 `node-webrtc`、`mediasoup`、`pion/webrtc`(Go)、`Janus` 等处理 RTP/SRTP
2. **DTLS/SRTP**：媒体必须加密传输
3. **Simulcast/SVC**：客户端发送多路分辨率，SFU 按订阅者网络情况选择性转发
4. **TURN 服务器**：coturn 部署，保证对称 NAT 下的连通性
5. **负载均衡**：多 SFU 实例 + 信令集群（Redis pub/sub 跨节点同步房间状态）
6. **带宽估计**：GCC/BWE 拥塞控制，动态调整码率
7. **丢包重传**：NACK/PLI/FEC 机制
8. **录制/回放**：录制到对象存储，支持点播回放
9. **鉴权**：JWT Token 验证加入权限
10. **HTTPS/WSS**：生产必须 HTTPS（摄像头 API 在非 HTTPS 下不可用）
