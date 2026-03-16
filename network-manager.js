const dgram = require('dgram');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { loadOrCreateCert, getCertFingerprint } = require('./cert-gen');
const { generateToken, generateSessionId, sessionIdFromToken, RelayServer, RelayStream, HolePuncher, WanNegotiator, RELAY_PORT_OFFSET, PUNCH_UDP_OFFSET } = require('./holepunch');
const { StunServer } = require('./stun-server');

const STUN_PORT_OFFSET    = 3; // transferPort + 3 = STUN server
const WAN_TCP_PORT_OFFSET = 5; // transferPort + 5 = plain TCP for WAN peers (no TLS)

const BROADCAST_PORT = 45454;
const TRANSFER_PORT_START = 45455;
const BROADCAST_INTERVAL = 3000;
const PEER_TIMEOUT = 10000;
const MAX_AVATAR_SIZE = 50000; // 50KB max for avatar in broadcast

class NetworkManager extends EventEmitter {
  constructor() {
    super();
    this.peers = new Map();
    this.config = this.loadConfig();
    this.username = this.config.username || os.hostname();
    this.peerId = this.config.peerId;
    this.avatar = this.config.avatar || null;
    this.favorites = this.config.favorites || {};
    this.broadcastSocket = null;
    this.transferServer = null;
    this.transferPort = TRANSFER_PORT_START;
    this.activeTransfers = new Map();
    // TLS — load or generate persistent self-signed cert
    this._tlsCreds = loadOrCreateCert();
    this._encryptLAN = this.config.encryptLAN !== false; // default ON
    // Relay server (started if UPnP succeeds)
    this._relayServer = null;
    this._relayPort   = null;
    this._relayPublicIp = null;
    // STUN server (started alongside relay)
    this._stunServer  = null;
    this._stunPort    = null;
    // Issued tokens: peerId → token (persisted in config)
    this._issuedTokens = new Map(Object.entries(this.config.issuedTokens || {}));
    // WAN session cache
    this._wanSessions = new Map();
    // STUN result cache
    this._stunCache   = new Map();
    // Reverse channel map: peerIp → socket
    this._reverseChannels = new Map();
    // Persistent inbound sockets: peerIp → Set<socket> (they connected to us)
    // Holds ALL active connections from a peer, not just the latest.
    // doneReading picks any live socket from the set for write-back.
    this._inboundSockets = new Map();
    // Persistent outbound sockets: peerId → socket (we connected to them)
    // Reused across message sends to keep the connection alive for write-back.
    this._outboundSockets = new Map();
    // Queue for WAN peers with asymmetric NAT: messages flushed on their next connection
    this._outboundQueue = new Map();
    // Persistent keepalive connections: peerId → { socket, timer, retryCount }
    // When we know a peer's WAN port, we maintain a persistent outbound connection
    // so they can always push messages down to us (Signal-style).
    this._persistentConns = new Map();
    // Dedicated plain-TCP server for WAN peers (no TLS, separate port).
    // WAN peers connect here regardless of the LAN TLS setting.
    this._wanServer = null;
    this._wanTcpPort = null;
  }

  getEncryptLAN() { return this._encryptLAN; }
  setEncryptLAN(val) {
    this._encryptLAN = !!val;
    this.config.encryptLAN = this._encryptLAN;
    this.saveConfig();
    // Restart transfer server with new setting
    if (this.transferServer) {
      try { this.transferServer.close(); } catch {}
      this.transferServer = null;
      this.startTransferServer();
    }
  }

  getMyFingerprint() { return this._tlsCreds.fingerprint; }

  loadConfig() {
    const configDir = path.join(os.homedir(), '.file-share-app');
    const configPath = path.join(configDir, 'config.json');
    
    // Create config directory if it doesn't exist
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Load or create config
    if (fs.existsSync(configPath)) {
      try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (err) {
        console.error('Error loading config:', err);
      }
    }

    // Create new config with persistent peer ID
    const newConfig = {
      peerId: crypto.randomBytes(16).toString('hex'),
      username: os.hostname(),
      avatar: null,
      favorites: {},
      receiveMode: 'ask-before' // 'ask-before', 'auto-accept-ask-location', 'auto-accept-downloads'
    };
    
    this.saveConfig(newConfig);
    return newConfig;
  }

  saveConfig(config = null) {
    const configDir = path.join(os.homedir(), '.file-share-app');
    const configPath = path.join(configDir, 'config.json');
    
    const configToSave = config || {
      peerId: this.peerId,
      username: this.username,
      avatar: this.avatar,
      favorites: this.favorites
    };

    try {
      fs.writeFileSync(configPath, JSON.stringify(configToSave, null, 2));
    } catch (err) {
      console.error('Error saving config:', err);
    }
  }

  start() {
    this.startBroadcast();
    this.startTransferServer();
    this.startWanServer();
    this.startPeerTimeout();
  }

  stop() {
    // Stop all persistent connections
    for (const [, conn] of this._persistentConns.entries()) {
      conn.stopped = true;
      if (conn.timer) clearTimeout(conn.timer);
      if (conn.socket && !conn.socket.destroyed) conn.socket.destroy();
    }
    this._persistentConns.clear();
    for (const [, transfer] of this.activeTransfers.entries()) {
      try { if (transfer.fileStream) transfer.fileStream.destroy(); } catch {}
      try { if (transfer.socket) transfer.socket.destroy(); } catch {}
    }
    this.activeTransfers.clear();
    if (this.broadcastSocket) { try { this.broadcastSocket.close(); } catch {} this.broadcastSocket = null; }
    if (this.transferServer) { try { this.transferServer.close(); } catch {} this.transferServer = null; }
    if (this.broadcastInterval) { clearInterval(this.broadcastInterval); this.broadcastInterval = null; }
    if (this.peerTimeoutInterval) { clearInterval(this.peerTimeoutInterval); this.peerTimeoutInterval = null; }
  }

  setUsername(username) {
    this.username = username;
    this.saveConfig();
  }

  setAvatar(base64Image) {
    // Validate size
    if (base64Image && base64Image.length > MAX_AVATAR_SIZE) {
      throw new Error('Avatar too large. Please use an image under 50KB.');
    }
    this.avatar = base64Image;
    this.saveConfig();
  }

  setReceiveMode(mode) {
    this.config.receiveMode = mode;
    this.saveConfig();
  }

  getReceiveMode() {
    return this.config.receiveMode || 'ask-before';
  }

  setFavoriteNickname(peerId, nickname) {
    if (nickname) {
      this.favorites[peerId] = nickname;
    } else {
      delete this.favorites[peerId];
    }
    this.saveConfig();
  }

  getFavoriteNickname(peerId) {
    return this.favorites[peerId] || null;
  }

  // Get broadcast addresses for real (non-virtual) network interfaces only.
  _getBroadcastAddresses() {
    const { getLocalIp } = require('./upnp-client'); // reuse scoring logic
    // We import the patterns directly to filter here too
    const VIRTUAL_NAME_PATTERNS = [
      'vbox', 'virtualbox', 'vmware', 'vmnet', 'vethernet',
      'hyper-v', 'hyperv', 'wsl', 'docker', 'virbr', 'virtual',
      'tap', 'tun', 'hamachi', 'nordvpn', 'expressvpn', 'mullvad',
    ];
    const VIRTUAL_IP_PREFIXES = [
      '192.168.56.', '192.168.99.', '192.168.122.', '10.0.2.',
      '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.',
      '172.23.', '172.24.', '172.25.', '172.26.', '172.27.',
      '172.28.', '172.29.', '172.30.', '172.31.',
      '169.254.',
    ];

    const addresses = new Set(['255.255.255.255']);

    for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
      const nameLower = name.toLowerCase();
      if (VIRTUAL_NAME_PATTERNS.some(p => nameLower.includes(p))) continue;

      for (const iface of ifaces) {
        if (iface.family !== 'IPv4' || iface.internal) continue;
        if (VIRTUAL_IP_PREFIXES.some(p => iface.address.startsWith(p))) continue;

        // Calculate subnet-directed broadcast
        const ipParts   = iface.address.split('.').map(Number);
        const maskParts = iface.netmask.split('.').map(Number);
        const bcast = ipParts.map((b, i) => (b | (~maskParts[i] & 0xff))).join('.');
        if (bcast !== '255.255.255.255') addresses.add(bcast);
      }
    }

    return [...addresses];
  }

  startBroadcast() {
    this.broadcastSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.broadcastSocket.on('error', (err) => {
      console.error('Broadcast socket error:', err);
    });

    this.broadcastSocket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.peerId === this.peerId) return;

        const peer = {
          id:             data.peerId,
          username:       data.username,
          ip:             rinfo.address,
          port:           data.transferPort,
          avatar:         data.avatar || null,
          nickname:       this.getFavoriteNickname(data.peerId),
          lastSeen:       Date.now(),
          tlsFingerprint: data.tlsFingerprint || null,
          encrypted:      !!data.encrypted,
        };

        const isNewPeer = !this.peers.has(peer.id);
        this.peers.set(peer.id, peer);
        if (isNewPeer) this.emit('peer-discovered', peer);
      } catch {}
    });

    this.broadcastSocket.bind(BROADCAST_PORT, () => {
      this.broadcastSocket.setBroadcast(true);

      // Also join the mDNS multicast group — this works across some bridged
      // subnets (WiFi extenders in bridge mode, powerline adapters) where
      // layer-3 broadcast is blocked but multicast at layer 2 passes through.
      try {
        this.broadcastSocket.addMembership('224.0.0.251');
        console.log('[broadcast] Joined mDNS multicast group 224.0.0.251');
      } catch (e) {
        console.warn('[broadcast] Could not join mDNS multicast (non-fatal):', e.message);
      }

      console.log(`[broadcast] Listening on port ${BROADCAST_PORT}`);
      this.broadcastInterval = setInterval(() => this.sendBroadcast(), BROADCAST_INTERVAL);
      this.sendBroadcast();
    });
  }

  sendBroadcast() {
    const message = JSON.stringify({
      peerId:        this.peerId,
      username:      this.username,
      transferPort:  this.transferPort,
      avatar:        this.avatar,
      tlsFingerprint: this._encryptLAN ? this._tlsCreds.fingerprint : null,
      encrypted:     this._encryptLAN,
    });

    const buffer    = Buffer.from(message);
    const targets   = this._getBroadcastAddresses();

    for (const addr of targets) {
      this.broadcastSocket.send(buffer, 0, buffer.length, BROADCAST_PORT, addr, (err) => {
        if (err) console.warn(`[broadcast] send to ${addr} failed:`, err.message);
      });
    }

    // Also send to mDNS multicast for cross-subnet extender coverage
    this.broadcastSocket.send(buffer, 0, buffer.length, BROADCAST_PORT, '224.0.0.251', (err) => {
      if (err && err.code !== 'ENETUNREACH') {
        // ENETUNREACH is normal if multicast routing isn't available — suppress it
        console.warn('[broadcast] mDNS multicast send failed:', err.message);
      }
    });
  }

  // Dedicated plain-TCP server for WAN peers.
  // Runs on transferPort+5, no TLS, UPnP maps it separately.
  // This ensures inbound WAN connections always reach the onSocket handler
  // regardless of whether LAN TLS is enabled.
  startWanServer() {
    this._wanTcpPort = this.transferPort + WAN_TCP_PORT_OFFSET;
    const onWanSocket = (socket) => this._handleWanSocket(socket);
    this._wanServer = net.createServer({ allowHalfOpen: true }, onWanSocket);
    this._wanServer.listen(this._wanTcpPort, () => {
      console.log(`[wan] Plain TCP server listening on port ${this._wanTcpPort}`);
    });
    this._wanServer.on('error', (e) => {
      console.warn('[wan] WAN server error:', e.message);
    });
  }

  getWanTcpPort() { return this._wanTcpPort; }

  _handleWanSocket(socket) {
    const remoteIp = socket.remoteAddress?.replace(/^::ffff:/, '');
    console.log(`[wan] Inbound WAN connection from ${remoteIp}:${socket.remotePort}`);

    socket.setKeepAlive(true, 15000);
    socket.setNoDelay(true);
    socket.allowHalfOpen = true;

    let wanPeer = Array.from(this.peers.values()).find(p => p.isWanDirect && p.ip === remoteIp);
    if (!wanPeer && remoteIp) {
      const stableId = 'wand-auto-' + remoteIp.replace(/[.:]/g, '_');
      wanPeer = Array.from(this.peers.values()).find(p => p.id === stableId);
      if (!wanPeer) {
        wanPeer = this.addWanDirectPeer(stableId, remoteIp, 0, remoteIp, { wanPort: 0 });
        console.log(`[wan] Auto-discovered WAN peer ${remoteIp}`);
      }
    }

    if (wanPeer) {
      if (!this._wanSessions.has(wanPeer.id)) {
        this._wanSessions.set(wanPeer.id, { method: 'tcp' });
        this.emit('wan-connection-method', { peerId: wanPeer.id, method: 'tcp' });
      }
      if (!this._inboundSockets.has(remoteIp)) this._inboundSockets.set(remoteIp, new Set());
      this._inboundSockets.get(remoteIp).add(socket);
      console.log(`[wan] Registered inbound socket from ${remoteIp}`);

      const queue = this._outboundQueue.get(wanPeer.id);
      if (queue && queue.length > 0) {
        this._outboundQueue.delete(wanPeer.id);
        console.log(`[wan] Flushing ${queue.length} queued msg(s) to ${remoteIp} on connect`);
        for (const item of queue) { try { socket.write(item); } catch {} }
      }
    }

    // Attach the persistent framer — handles all frame types and registers
    // cleanup listeners exactly once. Never tears down the socket.
    this._attachPersistentFramer(socket);
  }

  startPeerTimeout() {
    this.peerTimeoutInterval = setInterval(() => {
      const now = Date.now();
      for (const [peerId, peer] of this.peers.entries()) {
        if (peer.isWanDirect) continue; // WAN-direct peers are manually managed, never timed out
        if (now - peer.lastSeen > PEER_TIMEOUT) {
          this.peers.delete(peerId);
          this.emit('peer-left', peerId);
        }
      }
    }, 2000);
  }

  startTransferServer() {
    const onSocket = (socket) => {
      const remoteIp = socket.remoteAddress?.replace(/^::ffff:/, '');

      // Find existing WAN-direct peer by IP
      let wanPeer = Array.from(this.peers.values()).find(
        p => p.isWanDirect && p.ip === remoteIp
      );

      // ── Reverse discovery ──────────────────────────────────────────────────
      // Unknown WAN IP connecting to our TLS/transfer port. Auto-create a peer
      // entry so messages/files route correctly.
      // GUARD: only do this if the IP is not already a known LAN peer —
      // LAN peers connecting inbound would otherwise get a duplicate WAN entry.
      const isKnownLanPeer = Array.from(this.peers.values()).some(
        p => !p.isWanDirect && p.ip === remoteIp
      );
      if (!wanPeer && remoteIp && !isKnownLanPeer) {
        const stableId = 'wand-auto-' + remoteIp.replace(/[.:]/g, '_');
        wanPeer = Array.from(this.peers.values()).find(p => p.id === stableId);
        if (!wanPeer) {
          wanPeer = this.addWanDirectPeer(
            stableId, remoteIp, this.transferPort + WAN_TCP_PORT_OFFSET, remoteIp,
            { token: null, relayIp: null, relayPort: null, wanPort: this.transferPort + WAN_TCP_PORT_OFFSET }
          );
          console.log(`[wan] Auto-discovered incoming peer ${remoteIp}:${socket.remotePort}`);
        }
      }

      if (wanPeer) {
        // Emit connection method badge for inbound connections
        if (!this._wanSessions.has(wanPeer.id)) {
          this._wanSessions.set(wanPeer.id, { method: 'tcp' });
          this.emit('wan-connection-method', { peerId: wanPeer.id, method: 'tcp' });
        }
        socket.setKeepAlive(true, 15000);
        socket.setNoDelay(true);
        socket.allowHalfOpen = true;

        if (!this._inboundSockets.has(remoteIp)) this._inboundSockets.set(remoteIp, new Set());
        this._inboundSockets.get(remoteIp).add(socket);

        // Flush any queued outbound messages immediately
        const queueNow = this._outboundQueue.get(wanPeer.id);
        if (queueNow && queueNow.length > 0) {
          this._outboundQueue.delete(wanPeer.id);
          for (const item of queueNow) { try { socket.write(item); } catch {} }
        }

      }
      // WAN peer on TLS/transfer port: use persistent framer same as WAN server
      if (wanPeer) {
        this._attachPersistentFramer(socket);
      } else {
        this.handleIncomingTransfer(socket);
      }
    };

    if (this._encryptLAN) {
      this.transferServer = tls.createServer({
        cert: this._tlsCreds.cert,
        key:  this._tlsCreds.key,
        rejectUnauthorized: false,  // TOFU — we verify fingerprint in broadcast, not via CA
        requestCert: true,          // ask client to present cert so we can record their fingerprint
      }, onSocket);
      console.log('[TLS] Transfer server will use TLS (AES-256-GCM)');
    } else {
      this.transferServer = net.createServer(onSocket);
      console.log('[Net] Transfer server using plain TCP (encryption disabled)');
    }

    this.transferServer.listen(this.transferPort, () => {
      console.log(`Transfer server listening on port ${this.transferPort}`);
    });
  }

  // Attach a persistent framer to a long-lived WAN socket.
  // Processes frames one at a time from a continuous stream without ever
  // tearing down or re-attaching listeners. Call once per socket.
  _attachPersistentFramer(socket) {
    if (socket._framedAttached) return;
    socket._framedAttached = true;

    const peerIp = (socket.remoteAddress || '').replace(/^::ffff:/, '');
    let buf = Buffer.alloc(0);

    // Process as many complete frames as are available in buf.
    // A frame is: JSON-header + '\n\n' + optional binary body.
    // For message/typing/reaction/read frames the body is empty.
    // For file frames the body runs until socket 'end' — but we don't
    // use the framer for file sends over persistent sockets; files get
    // their own fresh connection so we never block the channel.
    const processFrames = () => {
      while (true) {
        const sep = buf.indexOf('\n\n');
        if (sep === -1) break; // need more data

        let fileInfo;
        try { fileInfo = JSON.parse(buf.slice(0, sep).toString()); }
        catch { socket.destroy(); return; }

        // Update peer port from senderPort in any frame
        if (fileInfo.senderPort) {
          const newPort = parseInt(fileInfo.senderPort);
          const autoPeer = Array.from(this.peers.values()).find(p => p.ip === peerIp && p.isWanDirect);
          if (autoPeer && newPort && newPort !== TRANSFER_PORT_START && autoPeer.port !== newPort) {
            autoPeer.port = newPort;
            autoPeer.wanPort = newPort;
            console.log(`[wan] Updated peer ${peerIp} port to ${newPort} from frame`);
            if (!this._persistentConns.has(autoPeer.id)) this._startPersistentConn(autoPeer);
          }
        }

        // Flush any queued outbound messages
        const qPeer = Array.from(this.peers.values()).find(p => p.ip === peerIp && p.isWanDirect);
        if (qPeer) {
          const q = this._outboundQueue.get(qPeer.id);
          if (q && q.length > 0) {
            this._outboundQueue.delete(qPeer.id);
            console.log(`[wan] Flushing ${q.length} queued msg(s) to ${peerIp} via framer`);
            for (const item of q) { try { socket.write(item); } catch {} }
          }
        }

        if (fileInfo.type === 'typing') {
          this.emit('typing-received', { sender: fileInfo.sender || '', typing: !!fileInfo.typing, peerIp });
          buf = buf.slice(sep + 2);
          continue;
        }
        if (fileInfo.type === 'reaction') {
          this.emit('reaction-received', { messageId: fileInfo.messageId, emoji: fileInfo.emoji, sender: fileInfo.sender, senderName: fileInfo.senderName, peerIp });
          buf = buf.slice(sep + 2);
          continue;
        }
        if (fileInfo.type === 'read') {
          this.emit('read-receipt', { messageId: fileInfo.messageId, sender: fileInfo.sender, peerIp });
          buf = buf.slice(sep + 2);
          continue;
        }
        if (fileInfo.type === 'message' || !fileInfo.filename) {
          if (fileInfo.message) {
            const decoded = fileInfo.encoding === 'base64'
              ? Buffer.from(fileInfo.message, 'base64').toString('utf8')
              : (fileInfo.message || '');
            this.emit('message-received', { message: decoded, reply: fileInfo.reply || null, sender: fileInfo.sender || 'Unknown', senderAvatar: fileInfo.senderAvatar || null, peerIp });
          }
          buf = buf.slice(sep + 2);
          continue;
        }

        // File frame on the persistent socket.
        // Swap out the framer's data listener for a dedicated file receiver.
        // The framer listener is restored once the file is fully received.
        const bodyStart = sep + 2;
        const fileSize = fileInfo.size || 0;

        // Save any bytes already in buf beyond the header; clear buf so the
        // framer doesn't see stale data when it resumes.
        const bodyAlreadyInBuf = buf.slice(bodyStart);
        buf = Buffer.alloc(0);

        const transferId = crypto.randomBytes(8).toString('hex');
        this.emit('file-incoming', {
          transferId, filename: fileInfo.filename, size: fileInfo.size,
          message: fileInfo.message || '', thumbnail: fileInfo.thumbnail || null,
          sender: fileInfo.sender || 'Unknown', senderAvatar: fileInfo.senderAvatar || null, peerIp,
        });

        let fileWriteStream = null;
        let receivedBytes = bodyAlreadyInBuf.length;
        let pendingChunks = bodyAlreadyInBuf.length > 0 ? [bodyAlreadyInBuf] : [];
        let savePath = null;
        let finishing = false;
        const hashCtx = crypto.createHash('sha256');
        if (bodyAlreadyInBuf.length > 0) hashCtx.update(bodyAlreadyInBuf);

        // Remove the framer's outer data listener while the file is in flight.
        // This prevents buf from accumulating file bytes and avoids double-processing.
        socket.removeListener('data', onData);

        const flushPending = () => {
          if (!fileWriteStream || !pendingChunks.length) return;
          for (const c of pendingChunks) fileWriteStream.write(c);
          pendingChunks = [];
        };

        const finishFile = () => {
          if (finishing) return;
          finishing = true;
          socket.removeListener('data', onFileData);
          if (fileWriteStream) {
            flushPending();
            fileWriteStream.end(() => {
              this.emit('file-received', { filename: fileInfo.filename, size: fileInfo.size, hash: hashCtx.digest('hex'), path: savePath });
              this.activeTransfers.delete(transferId);
            });
          }
          // Restore the framer's data listener and process any buffered frames
          socket.on('data', onData);
          processFrames();
        };

        let lastProgressEmitFile = 0;
        const onFileData = (chunk) => {
          hashCtx.update(chunk);
          receivedBytes += chunk.length;
          if (fileWriteStream) { fileWriteStream.write(chunk); }
          else { pendingChunks.push(chunk); }
          const now = Date.now();
          if (now - lastProgressEmitFile >= 100) {
            lastProgressEmitFile = now;
            this.emit('transfer-progress', {
              transferId, filename: fileInfo.filename,
              receivedBytes, totalBytes: fileSize,
              progress: fileSize > 0 ? (receivedBytes / fileSize) * 100 : 0,
              speed: 0,
            });
          }
          if (receivedBytes >= fileSize) finishFile();
        };

        socket.on('data', onFileData);

        this.activeTransfers.set(transferId, {
          socket, fileInfo,
          onSavePath: (sp) => {
            savePath = sp;
            fileWriteStream = fs.createWriteStream(sp);
            flushPending();
            if (receivedBytes >= fileSize) finishFile();
          },
          onDecline: () => {
            socket.removeListener('data', onFileData);
            socket.on('data', onData); // restore framer
            this.activeTransfers.delete(transferId);
            processFrames();
          },
        });

        // If entire file was already in buf (e.g. very small file), finish immediately
        if (receivedBytes >= fileSize) finishFile();

        // Break the processFrames loop — file mode is active.
        // processFrames resumes from finishFile/onDecline.
        break;
      }
    };

    // Keep a reference to the outer data handler so file mode can swap it out/in
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      processFrames();
    };
    socket.on('data', onData);

    // Clean up registries on close — only add these once
    socket.once('close', () => {
      const ibSet = this._inboundSockets.get(peerIp);
      if (ibSet) { ibSet.delete(socket); if (ibSet.size === 0) this._inboundSockets.delete(peerIp); }
      const wp = Array.from(this.peers.values()).find(p => p.ip === peerIp && p.isWanDirect);
      if (wp) {
        if (this._outboundSockets.get(wp.id) === socket) this._outboundSockets.delete(wp.id);
        this._wanSessions.delete(wp.id);
      }
    });
    socket.once('error', () => {}); // handled by close
  }

  handleIncomingTransfer(socket) {
    let headerReceived = false;
    let fileInfo = null;
    let receivedBytes = 0;
    let fileStream = null;
    let headerBuffer = Buffer.alloc(0);
    const transferId = crypto.randomBytes(8).toString('hex');
    let startTime = null;
    let lastProgressEmit = 0;
    const peerIp = (socket.remoteAddress || '').replace(/^::ffff:/, '');
    let pendingChunks = [];
    let transferComplete = false;
    // For persistent WAN sockets: after reading one message/frame, re-attach.
    // For regular (non-persistent) sockets: destroy.
    const doneReading = () => {
      const isInbound  = this._inboundSockets.get(peerIp)?.has(socket) ?? false;
      const isOutbound = Array.from(this._outboundSockets.values()).includes(socket);
      if (isInbound || isOutbound) {
        socket.removeAllListeners('data');
        this.handleIncomingTransfer(socket);
      } else {
        socket.destroy();
      }
    };

    // Store socket so we can cancel if declined
    this.activeTransfers.set(transferId, { socket });

    socket.on('data', (chunk) => {
      if (!headerReceived) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        
        // Look for header terminator (double newline)
        const headerEnd = headerBuffer.indexOf('\n\n');
        if (headerEnd !== -1) {
          const headerStr = headerBuffer.slice(0, headerEnd).toString();
          try { fileInfo = JSON.parse(headerStr); } catch (e) { console.warn('[wan] Bad header:', e.message); socket.destroy(); return; }

          // Handle text-only messages — check BOTH type field and absence of filename
          // If this is an auto-discovered peer, correct their port from the header
          if (fileInfo.senderPort) {
            const autoPeer = Array.from(this.peers.values()).find(p => p.ip === peerIp && p.isWanDirect);
            const newPort = parseInt(fileInfo.senderPort);
            // Only update port if it looks like a WAN port (not the default TLS port 45455).
            // senderPort now sends the WAN port; this guards against old clients.
            if (autoPeer && newPort && newPort !== TRANSFER_PORT_START && autoPeer.port !== newPort) {
              autoPeer.port = newPort;
              autoPeer.wanPort = newPort;
              console.log(`[wan] Updated peer ${peerIp} port to ${newPort} from header`);
              // Now that we know their port, start a persistent outbound connection
              // so we can reach them directly rather than relying solely on write-back.
              // This handles the case where the peer was auto-created with port=0 before
              // their senderPort arrived in the first message header.
              if (!this._persistentConns.has(autoPeer.id)) {
                this._startPersistentConn(autoPeer);
              }
            }
          }

          // Flush any queued outbound messages while inbound socket is still open.
          {
            const qPeer = Array.from(this.peers.values()).find(p => p.ip === peerIp && p.isWanDirect);
            if (qPeer) {
              const q = this._outboundQueue.get(qPeer.id);
              if (q && q.length > 0) {
                console.log(`[wan] Flushing ${q.length} queued msg(s) to ${peerIp}`);
                this._outboundQueue.delete(qPeer.id);
                for (const item of q) { try { socket.write(item); } catch {} }
              }
            }
          }

          if (fileInfo.type === 'typing') {
            this.emit('typing-received', { sender: fileInfo.sender || '', typing: !!fileInfo.typing, peerIp });
            doneReading();
            return;
          }
          if (fileInfo.type === 'reaction') {
            this.emit('reaction-received', { messageId: fileInfo.messageId, emoji: fileInfo.emoji, sender: fileInfo.sender, senderName: fileInfo.senderName, peerIp });
            doneReading();
            return;
          }
          if (fileInfo.type === 'read') {
            this.emit('read-receipt', { messageId: fileInfo.messageId, sender: fileInfo.sender, peerIp });
            doneReading();
            return;
          }
          if (fileInfo.type === 'message' || !fileInfo.filename) {
            if (fileInfo.message) {
              // Decode base64-encoded messages (new format); fall back to plain for old clients
              const decoded = fileInfo.encoding === 'base64'
                ? Buffer.from(fileInfo.message, 'base64').toString('utf8')
                : (fileInfo.message || '');
              this.emit('message-received', { message: decoded, reply: fileInfo.reply || null, sender: fileInfo.sender || 'Unknown', senderAvatar: fileInfo.senderAvatar || null, peerIp });
            }
            doneReading();
            return;
          }

          headerReceived = true;
          startTime = Date.now();
          
          // Emit incoming file event IMMEDIATELY
          this.emit('file-incoming', {
            transferId,
            filename: fileInfo.filename,
            size: fileInfo.size,
            message: fileInfo.message || '',
            thumbnail: fileInfo.thumbnail || null,
            sender: fileInfo.sender || 'Unknown',
            senderAvatar: fileInfo.senderAvatar || null,
            peerIp: peerIp
          });
          
          // Store remaining data
          const remainingData = headerBuffer.slice(headerEnd + 2);
          if (remainingData.length > 0) {
            pendingChunks.push(remainingData);
            receivedBytes += remainingData.length;
          }
        }
      } else {
        // Check if we have a save path yet
        const transfer = this.activeTransfers.get(transferId);
        
        if (transfer && transfer.declined) {
          socket.destroy();
          return;
        }
        
        if (transfer && transfer.savePath && !fileStream) {
          // User accepted! Start streaming to disk
          fileStream = fs.createWriteStream(transfer.savePath);
          transfer.fileStream = fileStream;
          
          // Write any pending chunks
          for (const pendingChunk of pendingChunks) {
            fileStream.write(pendingChunk);
          }
          pendingChunks = [];
        }
        
        if (fileStream) {
          // Stream directly to disk
          fileStream.write(chunk);
          receivedBytes += chunk.length;
          
          // Throttle progress updates to every 100ms to prevent flickering
          const now = Date.now();
          if (now - lastProgressEmit >= 100) {
            const elapsed = (now - startTime) / 1000;
            const speed = receivedBytes / elapsed;
            
            this.emit('transfer-progress', {
              transferId,
              filename: fileInfo.filename,
              receivedBytes,
              totalBytes: fileInfo.size,
              progress: (receivedBytes / fileInfo.size) * 100,
              speed: speed
            });
            
            lastProgressEmit = now;
          }
        } else {
          // Still waiting for accept/decline - buffer it
          pendingChunks.push(chunk);
          receivedBytes += chunk.length;
        }
      }
    });

    socket.on('end', () => {
      transferComplete = true;
      
      if (fileStream) {
        // File stream is open - finish writing
        fileStream.end();
        
        // Calculate hash after file is written
        const transfer = this.activeTransfers.get(transferId);
        if (transfer && transfer.savePath) {
          const hash = crypto.createHash('sha256');
          const readStream = fs.createReadStream(transfer.savePath);
          
          readStream.on('data', (chunk) => hash.update(chunk));
          readStream.on('end', () => {
            const fileHash = hash.digest('hex');
            
            this.emit('file-received', {
              filename: fileInfo.filename,
              size: fileInfo.size,
              hash: fileHash,
              path: transfer.savePath
            });
            
            this.activeTransfers.delete(transferId);
          });
        }
      } else {
        // Transfer completed but no file stream yet - keep buffered data
        const transfer = this.activeTransfers.get(transferId);
        if (transfer) {
          transfer.pendingChunks = pendingChunks;
          transfer.fileInfo = fileInfo;
          transfer.transferComplete = true;
          
          // Check periodically if save path is set
          const checkSavePath = setInterval(() => {
            const currentTransfer = this.activeTransfers.get(transferId);
            if (currentTransfer && currentTransfer.savePath && !currentTransfer.written) {
              currentTransfer.written = true;
              clearInterval(checkSavePath);
              
              // Write all buffered data to file
              const writeStream = fs.createWriteStream(currentTransfer.savePath);
              for (const chunk of currentTransfer.pendingChunks) {
                writeStream.write(chunk);
              }
              writeStream.end();
              
              writeStream.on('finish', () => {
                const hash = crypto.createHash('sha256');
                const readStream = fs.createReadStream(currentTransfer.savePath);
                
                readStream.on('data', (chunk) => hash.update(chunk));
                readStream.on('end', () => {
                  const fileHash = hash.digest('hex');
                  
                  this.emit('file-received', {
                    filename: fileInfo.filename,
                    size: fileInfo.size,
                    hash: fileHash,
                    path: currentTransfer.savePath
                  });
                  
                  this.activeTransfers.delete(transferId);
                });
              });
            } else if (!currentTransfer || currentTransfer.declined) {
              clearInterval(checkSavePath);
            }
          }, 100);
          
          // Timeout after 2 minutes
          setTimeout(() => {
            clearInterval(checkSavePath);
            if (this.activeTransfers.has(transferId)) {
              this.activeTransfers.delete(transferId);
            }
          }, 120000);
        }
      }
    });

    socket.on('error', (err) => {
      if (err.code !== 'ECONNABORTED' && err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        console.error('Transfer socket error:', err.message);
      }
      if (peerIp) {
        const ibSet = this._inboundSockets.get(peerIp);
        if (ibSet) { ibSet.delete(socket); if (ibSet.size === 0) this._inboundSockets.delete(peerIp); }
        const wp = Array.from(this.peers.values()).find(p => p.ip === peerIp && p.isWanDirect);
        if (wp) this._wanSessions.delete(wp.id);
      }
      for (const [pid, s] of this._outboundSockets) { if (s === socket) { this._outboundSockets.delete(pid); break; } }
      if (fileStream) fileStream.end();
      this.activeTransfers.delete(transferId);
      socket.destroy();
    });
  }

  discardReceivedFile(transferId) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) { this.activeTransfers.set(transferId, { declined: true }); return; }
    // Framer-based transfer: call the decline callback to resume the socket
    if (transfer.onDecline) { transfer.onDecline(); return; }
    // Legacy handleIncomingTransfer path: destroy the dedicated socket
    if (transfer.socket) transfer.socket.destroy();
    this.activeTransfers.set(transferId, { declined: true });
  }

  setSavePathForTransfer(transferId, savePath) {
    const existing = this.activeTransfers.get(transferId) || {};
    // Framer-based transfer: call the save-path callback directly
    if (existing.onSavePath) { existing.onSavePath(savePath); return; }
    // Legacy handleIncomingTransfer path: set savePath on the record
    existing.savePath = savePath;
    existing.accepted = true;
    this.activeTransfers.set(transferId, existing);
  }

  setPendingThumbnail(filePath, thumbnail) {
    if (!this.pendingThumbnails) this.pendingThumbnails = new Map();
    this.pendingThumbnails.set(filePath, thumbnail);
  }

  // ── Socket factory ────────────────────────────────────────────
  async _connectToPeer(peer, timeoutMs = 5000) {
    if (peer.isWanDirect) return this._connectWanPeer(peer, timeoutMs);
    return this._connectTCP(peer, timeoutMs);
  }

  // Raw TCP/TLS connect (LAN peers, and outbound WAN connects)
  _connectTCP(peer, timeoutMs = 5000) {
    if (!peer.port || peer.port === 0) return Promise.reject(new Error('No direct port known'));
    return new Promise((resolve, reject) => {
      const useTLS = this._encryptLAN && peer.encrypted;
      let socket;
      if (useTLS) {
        socket = tls.connect({ host: peer.ip, port: peer.port, rejectUnauthorized: false, checkServerIdentity: () => undefined });
        socket.once('secureConnect', () => {
          if (peer.tlsFingerprint) {
            const actualFp = socket.getPeerCertificate()?.fingerprint256;
            if (actualFp && actualFp !== peer.tlsFingerprint) { socket.destroy(); reject(new Error(`TLS fingerprint mismatch for ${peer.username}`)); return; }
          }
          resolve(socket);
        });
      } else {
        socket = new net.Socket();
        socket.connect(peer.port, peer.ip, () => resolve(socket));
      }
      socket.once('error', reject);
      socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('Connection timeout')); });
    });
  }

  // ── WAN connect: one persistent socket per peer, kept alive forever ──────
  //
  // Strategy (tried in order, first success wins and is cached):
  //   1. Reuse existing live socket (outbound or inbound write-back).
  //   2. Try direct outbound TCP to peer's known WAN port.
  //   3. Use any live inbound socket from peer (they reached us; write back).
  //   4. Queue — wait for peer to connect to us, flush on arrival.
  //
  // Once a socket is established it stays open. keepalive is enabled so the
  // OS kills it if the remote end disappears, and _startPersistentConn
  // auto-reconnects on close.  No socket is ever closed by the send path.
  async _connectWanPeer(peer, timeoutMs = 5000) {
    // 1. Reuse live outbound socket (we connected to them)
    const outbound = this._outboundSockets.get(peer.id);
    if (outbound && !outbound.destroyed && !outbound.writableEnded) return outbound;

    // 2. Inbound write-back: they connected to us — use it BEFORE trying outbound TCP.
    // This avoids a 2-second TCP timeout on every send when we know a channel exists.
    const inboundSet = this._inboundSockets.get(peer.ip);
    const inbound = inboundSet ? [...inboundSet].find(s => !s.destroyed && !s.writableEnded) : null;
    if (inbound) {
      console.log(`[wan] Write-back via inbound socket for ${peer.ip}`);
      this._wanSessions.set(peer.id, { method: 'tcp' });
      this.emit('wan-connection-method', { peerId: peer.id, method: 'tcp' });
      const q = this._outboundQueue.get(peer.id);
      if (q && q.length > 0) { this._outboundQueue.delete(peer.id); for (const item of q) { try { inbound.write(item); } catch {} } }
      return inbound;
    }

    // 3. Try direct outbound TCP to peer's known port (they may have UPnP too)
    if (peer.port && peer.port !== 0) {
      const sock = await this._connectTCP(peer, Math.min(timeoutMs, 2000)).catch(() => null);
      if (sock) {
        sock.setKeepAlive(true, 15000);
        sock.setNoDelay(true);
        this._outboundSockets.set(peer.id, sock);
        this._wanSessions.set(peer.id, { method: 'tcp' });
        this.emit('wan-connection-method', { peerId: peer.id, method: 'tcp' });
        this._attachPersistentFramer(sock);
        const q = this._outboundQueue.get(peer.id);
        if (q && q.length > 0) { this._outboundQueue.delete(peer.id); for (const item of q) { try { sock.write(item); } catch {} } }
        sock.once('close', () => {
          if (this._outboundSockets.get(peer.id) === sock) {
            this._outboundSockets.delete(peer.id);
            this._wanSessions.delete(peer.id);
          }
          if (!this._persistentConns.get(peer.id)?.stopped) {
            setTimeout(() => { if (this.peers.has(peer.id)) this._startPersistentConn(this.peers.get(peer.id)); }, 1000);
          }
        });
        sock.once('error', () => {});
        return sock;
      }
    }

    // 4. No route yet — queue and wait for peer's next inbound connection
    console.log(`[wan] No route to ${peer.ip}:${peer.port} yet — queuing`);
    const queue = this._outboundQueue.get(peer.id) || [];
    this._outboundQueue.set(peer.id, queue);
    return { write(d) { queue.push(d); }, end() {}, destroyed: false, writableEnded: false, _isQueue: true };
  }

  // Called from startTransferServer when an incoming TCP connection arrives
  // from a WAN-direct peer — we respond to their punch-offer if present.
  // If the initiator connected via plain TCP (UPnP working on both sides),
  // they won't send a punch-offer line, readLine times out, and we proceed
  // with normal handleIncomingTransfer unaffected.
  async _handleWanNegotiation(socket, wanPeer) {
    const relayEp      = this.getRelayEndpoint();
    const localUdpPort = this.transferPort + PUNCH_UDP_OFFSET;

    const negotiator = new WanNegotiator(socket, {
      isInitiator:     false,
      localUdpPort,
      relayIp:         relayEp?.ip   || null,
      relayPort:       relayEp?.port || null,
      registerSession: this.isRelayAvailable()
        ? (sid) => this.registerRelaySession(sid)
        : null,
    });

    try {
      const result = await negotiator.negotiate();
      if (result.method !== 'tcp') {
        // Only log/emit non-trivial results (TCP is the silent happy path)
        console.log(`[punch] Responder negotiated: ${result.method}`);
        if (wanPeer) {
          this._wanSessions.set(wanPeer.id, result);
          this.emit('wan-connection-method', { peerId: wanPeer.id, method: result.method });
        }
      }
    } catch (e) {
      // Non-fatal — older client or plain TCP initiator
    }
  }



  async sendTyping(peerId, isTyping) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const header = JSON.stringify({ type: 'typing', typing: isTyping, sender: this.username, senderPort: this._wanTcpPort || this.transferPort }) + '\n\n';
    try {
      const socket = await this._connectToPeer(peer, 1000);
      if (socket._isQueue || socket.destroyed || socket.writableEnded) return;
      if (peer.isWanDirect) { socket.write(header); } else { socket.write(header, () => socket.end()); }
    } catch {}
  }

  async sendMessage(peerId, message, reply = null) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer not found');
    const encoded = Buffer.from(message, 'utf8').toString('base64');
    const payload = { type: 'message', message: encoded, encoding: 'base64', sender: this.username, senderAvatar: this.avatar, senderPort: this._wanTcpPort || this.transferPort };
    if (reply) payload.reply = reply;
    const header = JSON.stringify(payload) + '\n\n';
    const socket = await this._connectToPeer(peer);
    if (socket._isQueue) { socket.write(header); return { success: true, queued: true }; }
    return new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.write(header, (err) => {
        if (err) return reject(err);
        if (!peer.isWanDirect) socket.end();
        resolve({ success: true });
      });
    });
  }

  async sendReaction(peerId, messageId, emoji) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const payload = { type: 'reaction', messageId, emoji, sender: this.peerId, senderName: this.username, senderPort: this._wanTcpPort || this.transferPort };
    const header = JSON.stringify(payload) + '\n\n';
    try {
      const socket = await this._connectToPeer(peer, 3000);
      if (peer.isWanDirect) { socket.write(header); } else { socket.write(header, () => socket.end()); }
    } catch (e) { console.warn('[sendReaction] failed:', e.message); }
  }

  async sendReadReceipt(peerId, messageId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const payload = { type: 'read', messageId, sender: this.peerId, senderPort: this._wanTcpPort || this.transferPort };
    const header = JSON.stringify(payload) + '\n\n';
    try {
      const socket = await this._connectToPeer(peer, 2000);
      if (peer.isWanDirect) { socket.write(header); } else { socket.write(header, () => socket.end()); }
    } catch {}
  }

  async sendFile(peerId, filePath, message = '') {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer not found');

    const fileStats = fs.statSync(filePath);
    const filename = path.basename(filePath);

    let thumbnail = null;
    const ext = filename.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) {
      try {
        const imageData = fs.readFileSync(filePath);
        const base64 = imageData.toString('base64');
        if (base64.length < 800000) thumbnail = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${base64}`;
      } catch (err) { console.error('Thumbnail error:', err); }
    } else if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'wmv', 'flv'].includes(ext)) {
      const extracted = this.pendingThumbnails?.get(filePath);
      if (extracted) { thumbnail = extracted; this.pendingThumbnails.delete(filePath); }
      else thumbnail = `__video__:${ext}`;
    }

    const header = JSON.stringify({ filename, size: fileStats.size, message, thumbnail, sender: this.username, senderAvatar: this.avatar }) + '\n\n';

    // Files always use a fresh dedicated TCP connection, never the persistent socket.
    // Streaming a large file inline would block all message frames until done and
    // cause the receiver's framer to buffer the entire file body in RAM.
    let client;
    if (peer.isWanDirect) {
      client = await this._connectTCP(peer, 5000).catch(async () => {
        console.log(`[sendFile] Direct TCP failed for ${peer.ip}, using persistent socket`);
        return this._connectWanPeer(peer);
      });
    } else {
      client = await this._connectToPeer(peer);
    }
    client.setNoDelay(true);

    const usingPersistent = !!(this._inboundSockets.get(peer.ip)?.has(client) || this._outboundSockets.get(peerId) === client);

    return new Promise((resolve, reject) => {
      client.write(header);

      const fileStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
      let sentBytes = 0, lastProgressEmit = 0, isPaused = false;

      const onDrain = () => { if (isPaused) { fileStream.resume(); isPaused = false; } };
      client.on('drain', onDrain);

      fileStream.on('data', (chunk) => {
        const canContinue = client.write(chunk);
        sentBytes += chunk.length;
        const now = Date.now();
        if (now - lastProgressEmit >= 100) {
          this.emit('transfer-progress', { peerId, filename, sentBytes, totalBytes: fileStats.size, progress: (sentBytes / fileStats.size) * 100 });
          lastProgressEmit = now;
        }
        if (!canContinue && !isPaused) { fileStream.pause(); isPaused = true; }
      });
      fileStream.on('end', () => {
        client.removeListener('drain', onDrain);
        if (!usingPersistent) client.end();
        this.emit('transfer-complete', { peerId, filename, size: fileStats.size, message, thumbnail });
        resolve({ success: true });
      });
      fileStream.on('error', (err) => { client.removeListener('drain', onDrain); if (!usingPersistent) client.destroy(); reject(err); });
      client.once('error', (err) => { client.removeListener('drain', onDrain); reject(err); });
    });
  }

  getPeers() {
    return Array.from(this.peers.values());
  }

  getTransferPort() {
    return this.transferPort;
  }

  // ── Relay server (UPnP-capable side only) ───────────────────
  // Call this after UPnP succeeds.  Opens a UDP relay socket and
  // registers the mapped port.  Returns the relay endpoint string.
  async startRelayServer(publicIp, upnpClient) {
    if (this._relayServer) return this.getRelayEndpoint();
    const relayPort = this.transferPort + RELAY_PORT_OFFSET;
    const srv = new RelayServer();
    try {
      await srv.listen(relayPort);
    } catch (e) {
      await srv.listen(relayPort + 1);
    }
    // Restore any persisted tokens
    for (const token of this._issuedTokens.values()) srv.addToken(token);
    this._relayServer   = srv;
    this._relayPort     = srv.port;
    this._relayPublicIp = publicIp;
    // Map relay port via UPnP
    try { await upnpClient.addPortMappingWithFallback(this._relayPort, 'Edge-Relay', 'UDP'); } catch {}

    // Start STUN server on transferPort+3
    if (!this._stunServer) {
      const stunPort = this.transferPort + STUN_PORT_OFFSET;
      const stun = new StunServer();
      try {
        await stun.listen(stunPort);
        this._stunServer = stun;
        this._stunPort   = stun.port;
        // Map STUN port via UPnP (UDP)
        try { await upnpClient.addPortMappingWithFallback(this._stunPort, 'Edge-STUN', 'UDP'); } catch {}
        console.log(`[STUN] Self-hosted server ready at ${publicIp}:${this._stunPort}`);
      } catch (e) {
        console.warn('[STUN] Failed to start self-hosted server:', e.message);
      }
    }

    this.emit('relay-started', { ip: publicIp, port: this._relayPort });
    return this.getRelayEndpoint();
  }

  getRelayEndpoint() {
    if (!this._relayServer) return null;
    return { ip: this._relayPublicIp, port: this._relayPort };
  }

  getStunEndpoint() {
    if (!this._stunServer) return null;
    return { ip: this._relayPublicIp, port: this._stunPort };
  }

  isRelayAvailable()    { return !!this._relayServer; }
  isStunAvailable()     { return !!this._stunServer; }

  // Issue a token for a specific peer (call when adding a WAN-direct peer)
  issueTokenForPeer(peerId) {
    if (this._issuedTokens.has(peerId)) return this._issuedTokens.get(peerId);
    const token = generateToken();
    this._issuedTokens.set(peerId, token);
    if (this._relayServer) this._relayServer.addToken(token);
    // Persist
    this.config.issuedTokens = Object.fromEntries(this._issuedTokens);
    this.saveConfig();
    return token;
  }

  revokeTokenForPeer(peerId) {
    const token = this._issuedTokens.get(peerId);
    if (token) {
      this._issuedTokens.delete(peerId);
      if (this._relayServer) this._relayServer.removeToken(token);
      this.config.issuedTokens = Object.fromEntries(this._issuedTokens);
      this.saveConfig();
    }
  }

  getTokenForPeer(peerId) { return this._issuedTokens.get(peerId) || null; }

  // Register a relay session for two peers about to connect
  registerRelaySession(sessionId) {
    if (this._relayServer) this._relayServer.registerSession(sessionId);
  }

  // ── Hole-punch attempt ────────────────────────────────────────
  // Called by main process after TCP connection is established.
  // Negotiates over the already-open TCP socket, then tries UDP punch.
  // Returns { method: 'direct'|'relay'|'none', ... }
  async attemptHolePunch({ tcpSocket, isRelayHost, remoteIp, remoteUdpPort, relayIp, relayPort, token, sessionId }) {
    const localUdpPort = this.transferPort + 1; // punch port = transferPort+1
    const puncher = new HolePuncher({
      localPort:  localUdpPort,
      remoteIp,
      remotePort: remoteUdpPort,
      relayIp:    relayIp  || null,
      relayPort:  relayPort || null,
      token:      token    || null,
      sessionId:  sessionId || null,
    });
    return await puncher.attempt();
  }

  // ── WAN Direct peers ────────────────────────────────────────
  // Inject a synthetic peer into the same peers Map so all existing
  // sendFile / sendMessage / sendTyping logic works unchanged.
  addWanDirectPeer(id, ip, port, label, { token, relayIp, relayPort, stunPort, selfStunPort, wanPort } = {}) {
    // wanPort: the dedicated plain-TCP WAN port (transferPort+5 = 45460)
    // port: the main TCP port from the address string (used as fallback)
    // WAN peers always use plain TCP (no TLS) on wanPort
    const connectPort = wanPort || port;
    const peer = {
      id,
      ip,
      port:         connectPort,
      wanPort:      connectPort,
      username:     label || `${ip}:${port}`,
      avatar:       null,
      nickname:     null,
      lastSeen:     Date.now(),
      isWanDirect:  true,
      encrypted:    false,           // WAN peers never use TLS
      token:        token        || null,
      relayIp:      relayIp      || null,
      relayPort:    relayPort    || null,
      stunPort:     stunPort     || null,
      selfStunPort: selfStunPort || null,
    };
    this.peers.set(id, peer);
    this.emit('peer-discovered', peer);

    // Start persistent connection if peer has a known port (they have UPnP/open port).
    // This is the Signal-style pattern: we connect outbound once and keep it alive,
    // so they can push messages down to us without needing our port open.
    if (connectPort && connectPort !== 0) {
      this._startPersistentConn(peer);
    }

    return peer;
  }

  removeWanDirectPeer(id) {
    if (this.peers.has(id)) {
      // Stop persistent connection if running
      const conn = this._persistentConns.get(id);
      if (conn) {
        conn.stopped = true;
        if (conn.timer) clearTimeout(conn.timer);
        if (conn.socket && !conn.socket.destroyed) conn.socket.destroy();
        this._persistentConns.delete(id);
      }
      this.revokeTokenForPeer(id);
      this._wanSessions.delete(id);
      this.peers.delete(id);
      this.emit('peer-left', id);
    }
  }

  // Maintain a persistent outbound TCP connection to a WAN peer that has an open port.
  // This is the "Signal pattern": we connect outbound once and keep it alive.
  // The server side (peer with open port) can then push messages down to us
  // through this persistent inbound socket — no open port needed on our side.
  _startPersistentConn(peer) {
    if (!peer.port || peer.port === 0) return;
    if (this._persistentConns.get(peer.id)?.stopped) return;

    const state = this._persistentConns.get(peer.id) || { retryCount: 0, stopped: false };
    this._persistentConns.set(peer.id, state);

    const attemptConnect = async () => {
      if (state.stopped) return;
      const currentPeer = this.peers.get(peer.id);
      if (!currentPeer) return;

      try {
        const sock = await this._connectTCP(currentPeer, 5000);
        sock.setKeepAlive(true, 15000);
        sock.setNoDelay(true);
        state.retryCount = 0;
        state.socket = sock;
        console.log(`[wan] Persistent connection established to ${currentPeer.ip}:${currentPeer.port}`);

        // Register as outbound socket so sends reuse it
        this._outboundSockets.set(peer.id, sock);

        // Listen for messages pushed down from the server (framer, never torn down)
        this._attachPersistentFramer(sock);

        // Flush any queued messages now that we have a connection
        const queue = this._outboundQueue.get(peer.id);
        if (queue && queue.length > 0) {
          console.log(`[wan] Flushing ${queue.length} queued msg(s) via persistent conn`);
          this._outboundQueue.delete(peer.id);
          for (const item of queue) { try { sock.write(item); } catch {} }
        }

        // Reconnect when socket closes
        sock.once('close', () => {
          if (this._outboundSockets.get(peer.id) === sock) {
            this._outboundSockets.delete(peer.id);
            this._wanSessions.delete(peer.id);
          }
          if (!state.stopped) {
            const delay = Math.min(1000 * Math.pow(2, state.retryCount), 30000);
            state.retryCount++;
            console.log(`[wan] Persistent conn to ${currentPeer.ip} closed — reconnecting in ${delay}ms`);
            state.timer = setTimeout(attemptConnect, delay);
          }
        });

        sock.once('error', () => {}); // handled by close

      } catch (e) {
        if (!state.stopped) {
          const delay = Math.min(1000 * Math.pow(2, state.retryCount), 30000);
          state.retryCount++;
          state.timer = setTimeout(attemptConnect, delay);
        }
      }
    };

    // Initial connection attempt with short delay to let startup settle
    state.timer = setTimeout(attemptConnect, 1000);
  }

  // Keep WAN-direct peers "alive" — call periodically from main
  heartbeatWanDirectPeers() {
    for (const [id, peer] of this.peers) {
      if (peer.isWanDirect) peer.lastSeen = Date.now();
    }
  }
}

module.exports = NetworkManager;
