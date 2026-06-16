const { EventEmitter } = require('events');

class SFU extends EventEmitter {
  constructor() {
    super();
    this.routes = new Map();
    this.clientStreams = new Map();
  }

  registerClient(clientId, roomId) {
    if (!this.clientStreams.has(clientId)) {
      this.clientStreams.set(clientId, {
        id: clientId,
        roomId,
        incomingTracks: new Map(),
        outgoingTargets: new Set(),
        ssrcMap: new Map()
      });
    }
    const entry = this.clientStreams.get(clientId);
    entry.roomId = roomId;
    console.log(`[SFU] 注册客户端 ${clientId} 到房间 ${roomId}`);
  }

  addRoute(senderId, receiverId, trackId, kind) {
    const routeKey = `${senderId}:${receiverId}:${trackId}`;
    this.routes.set(routeKey, {
      senderId,
      receiverId,
      trackId,
      kind,
      active: true,
      createdAt: Date.now(),
      packetsForwarded: 0,
      bytesForwarded: 0
    });

    const senderEntry = this.clientStreams.get(senderId);
    if (senderEntry) {
      senderEntry.incomingTracks.set(trackId, { kind, receiverId });
    }

    const receiverEntry = this.clientStreams.get(receiverId);
    if (receiverEntry) {
      receiverEntry.outgoingTargets.add(senderId);
    }

    console.log(`[SFU] 添加转发路由: ${senderId} -> ${receiverId} (track=${trackId}, kind=${kind})`);
    return this.routes.get(routeKey);
  }

  removeRoute(senderId, receiverId, trackId = null) {
    if (trackId) {
      const routeKey = `${senderId}:${receiverId}:${trackId}`;
      const route = this.routes.get(routeKey);
      if (route) {
        route.active = false;
        this.routes.delete(routeKey);
        console.log(`[SFU] 移除转发路由: ${senderId} -> ${receiverId} (track=${trackId})`);
      }
    } else {
      for (const [key, route] of this.routes) {
        if (route.senderId === senderId && route.receiverId === receiverId) {
          route.active = false;
          this.routes.delete(key);
        }
      }
      console.log(`[SFU] 移除所有转发路由: ${senderId} -> ${receiverId}`);
    }
  }

  getRoutesForSender(senderId) {
    const result = [];
    for (const [key, route] of this.routes) {
      if (route.senderId === senderId && route.active) {
        result.push(route);
      }
    }
    return result;
  }

  getRoutesForReceiver(receiverId) {
    const result = [];
    for (const [key, route] of this.routes) {
      if (route.receiverId === receiverId && route.active) {
        result.push(route);
      }
    }
    return result;
  }

  forwardPacket(senderId, trackId, packet, seq = 0) {
    const packetSize = packet.length || 0;
    const receiverDetails = [];

    for (const [key, route] of this.routes) {
      if (route.senderId === senderId && route.trackId === trackId && route.active) {
        route.packetsForwarded++;
        route.bytesForwarded += packetSize;
        route.lastForwardedAt = Date.now();
        route.lastSeq = seq;

        receiverDetails.push({
          receiverId: route.receiverId,
          kind: route.kind,
          trackId: route.trackId,
          packetsForThisRoute: route.packetsForwarded,
          bytesForThisRoute: route.bytesForwarded
        });

        this.emit('packet', {
          receiverId: route.receiverId,
          senderId,
          trackId,
          kind: route.kind,
          packet,
          seq,
          routeKey: key,
          totalForRoute: route.packetsForwarded
        });
      }
    }
    return {
      totalReceivers: receiverDetails.length,
      receiverDetails
    };
  }

  forwardMediaStats(senderId, trackId, stats) {
    const routes = this.getRoutesForSender(senderId);
    routes.forEach(route => {
      this.emit('stats', {
        receiverId: route.receiverId,
        senderId,
        trackId,
        kind: route.kind,
        stats
      });
    });
  }

  setupFullMeshRoutes(roomId, clientIds, newClientId) {
    const addedRoutes = [];

    for (const existingId of clientIds) {
      if (existingId === newClientId) continue;

      addedRoutes.push(this.addRoute(existingId, newClientId, `audio-${existingId}`, 'audio'));
      addedRoutes.push(this.addRoute(existingId, newClientId, `video-${existingId}`, 'video'));

      addedRoutes.push(this.addRoute(newClientId, existingId, `audio-${newClientId}`, 'audio'));
      addedRoutes.push(this.addRoute(newClientId, existingId, `video-${newClientId}`, 'video'));
    }

    console.log(`[SFU] 为新客户端 ${newClientId} 建立 ${addedRoutes.length} 条转发路由`);
    return addedRoutes;
  }

  unregisterClient(clientId) {
    for (const [key, route] of this.routes) {
      if (route.senderId === clientId || route.receiverId === clientId) {
        route.active = false;
        this.routes.delete(key);
      }
    }

    const entry = this.clientStreams.get(clientId);
    if (entry) {
      for (const otherEntry of this.clientStreams.values()) {
        otherEntry.outgoingTargets.delete(clientId);
      }
      this.clientStreams.delete(clientId);
    }

    console.log(`[SFU] 注销客户端 ${clientId}, 清理所有关联路由`);
  }

  getStats() {
    let totalPackets = 0;
    let totalBytes = 0;
    for (const route of this.routes.values()) {
      totalPackets += route.packetsForwarded;
      totalBytes += route.bytesForwarded;
    }
    return {
      activeRoutes: this.routes.size,
      registeredClients: this.clientStreams.size,
      totalPacketsForwarded: totalPackets,
      totalBytesForwarded: totalBytes
    };
  }

  getPerClientStats() {
    const clientStats = new Map();

    const ensureClient = (id) => {
      if (!clientStats.has(id)) {
        clientStats.set(id, {
          clientId: id,
          sentPackets: 0,
          sentBytes: 0,
          receivedPackets: 0,
          receivedBytes: 0,
          routesAsSender: 0,
          routesAsReceiver: 0,
          perReceiverBreakdown: new Map(),
          perPublisherBreakdown: new Map()
        });
      }
      return clientStats.get(id);
    };

    for (const route of this.routes.values()) {
      if (!route.active) continue;

      const senderStats = ensureClient(route.senderId);
      senderStats.sentPackets += route.packetsForwarded;
      senderStats.sentBytes += route.bytesForwarded;
      senderStats.routesAsSender++;

      const receiverKey = `${route.receiverId}:${route.trackId}`;
      senderStats.perReceiverBreakdown.set(receiverKey, {
        receiverId: route.receiverId,
        trackId: route.trackId,
        kind: route.kind,
        packets: route.packetsForwarded,
        bytes: route.bytesForwarded,
        lastForwardedAt: route.lastForwardedAt || null,
        lastSeq: route.lastSeq || 0
      });

      const receiverStats = ensureClient(route.receiverId);
      receiverStats.receivedPackets += route.packetsForwarded;
      receiverStats.receivedBytes += route.bytesForwarded;
      receiverStats.routesAsReceiver++;

      const publisherKey = `${route.senderId}:${route.trackId}`;
      receiverStats.perPublisherBreakdown.set(publisherKey, {
        publisherId: route.senderId,
        trackId: route.trackId,
        kind: route.kind,
        packets: route.packetsForwarded,
        bytes: route.bytesForwarded,
        lastForwardedAt: route.lastForwardedAt || null,
        lastSeq: route.lastSeq || 0
      });
    }

    const result = {};
    for (const [id, stats] of clientStats) {
      result[id] = {
        ...stats,
        perReceiverBreakdown: Object.fromEntries(stats.perReceiverBreakdown),
        perPublisherBreakdown: Object.fromEntries(stats.perPublisherBreakdown)
      };
    }
    return result;
  }
}

module.exports = SFU;
