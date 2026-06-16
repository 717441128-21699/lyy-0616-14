const { v4: uuidv4 } = require('uuid');

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(roomId = null) {
    const id = roomId || uuidv4().slice(0, 8);
    if (this.rooms.has(id)) {
      return this.rooms.get(id);
    }
    const room = {
      id,
      clients: new Map(),
      ownerId: null,
      createdAt: Date.now(),
      metadata: {}
    };
    this.rooms.set(id, room);
    console.log(`[RoomManager] 创建房间: ${id}`);
    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  getOwner(roomId) {
    const room = this.getRoom(roomId);
    return room ? room.ownerId : null;
  }

  setOwner(roomId, clientId) {
    const room = this.getRoom(roomId);
    if (!room) return null;
    room.ownerId = clientId;
    console.log(`[RoomManager] 房间 ${roomId} 房主变更为: ${clientId}`);
    return room;
  }

  joinRoom(roomId, client) {
    let room = this.getRoom(roomId);
    if (!room) {
      room = this.createRoom(roomId);
    }
    room.clients.set(client.id, client);
    if (!room.ownerId) {
      room.ownerId = client.id;
      console.log(`[RoomManager] ${client.id} 成为房间 ${roomId} 的房主`);
    }
    console.log(`[RoomManager] 客户端 ${client.id} 加入房间 ${roomId}, 当前人数: ${room.clients.size}`);
    return room;
  }

  leaveRoom(roomId, clientId) {
    const room = this.getRoom(roomId);
    if (!room) return null;
    room.clients.delete(clientId);
    console.log(`[RoomManager] 客户端 ${clientId} 离开房间 ${roomId}, 当前人数: ${room.clients.size}`);

    if (room.ownerId === clientId && room.clients.size > 0) {
      const firstRemaining = Array.from(room.clients.keys())[0];
      room.ownerId = firstRemaining;
      console.log(`[RoomManager] 房主 ${clientId} 离开，房间 ${roomId} 新房主为: ${firstRemaining}`);
    }

    if (room.clients.size === 0) {
      this.rooms.delete(roomId);
      console.log(`[RoomManager] 房间 ${roomId} 已空，销毁`);
    }
    return room;
  }

  getOtherClients(roomId, excludeClientId) {
    const room = this.getRoom(roomId);
    if (!room) return [];
    return Array.from(room.clients.values()).filter(c => c.id !== excludeClientId);
  }

  getClientIds(roomId) {
    const room = this.getRoom(roomId);
    if (!room) return [];
    return Array.from(room.clients.keys());
  }

  broadcastToRoom(roomId, message, excludeClientId = null) {
    const room = this.getRoom(roomId);
    if (!room) return;
    for (const [clientId, client] of room.clients) {
      if (clientId !== excludeClientId && client.ws && client.ws.readyState === 1) {
        client.ws.send(JSON.stringify(message));
      }
    }
  }

  sendToClient(clientId, message) {
    for (const room of this.rooms.values()) {
      const client = room.clients.get(clientId);
      if (client && client.ws && client.ws.readyState === 1) {
        client.ws.send(JSON.stringify(message));
        return true;
      }
    }
    return false;
  }
}

module.exports = RoomManager;
