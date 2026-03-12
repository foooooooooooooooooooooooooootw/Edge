const dgram = require('dgram');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { loadOrCreateCert, getCertFingerprint } = require('./cert-gen');
const { generateToken, generateSessionId, RelayServer, RelayStream, HolePuncher, WanNegotiator, RELAY_PORT_OFFSET, PUNCH_UDP_OFFSET } = require('./holepunch');

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
    // Issued tokens: peerId → token (persisted in config)
    this._issuedTokens = new Map(Object.entries(this.config.issuedTokens || {}));
    // WAN session cache: peerId → { method:'direct'|'relay'|'tcp', stream? }
    // Avoids re-negotiating on every message to the same WAN peer.
    this._wanSessions = new Map();
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
    this.startPeerTimeout();
  }

  stop() {
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

  // Get all broadcast addresses for this machine's network interfaces.
  // Returns the limited broadcast (255.255.255.255) plus a subnet-directed
  // broadcast for each active IPv4 interface (e.g. 192.168.1.255).
  // Subnet-directed broadcasts are forwarded by some WiFi extenders and
  // managed switches where limited broadcast is blocked.
  _getBroadcastAddresses() {
    const addresses = new Set(['255.255.255.255']);
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const iface of ifaces) {
        if (iface.family !== 'IPv4' || iface.internal) continue;
        // Calculate subnet broadcast: (ip | ~mask)
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

      // ── Reverse discovery ──────────────────────────────────
      // Unknown IP connecting to our port = someone added us but we haven't
      // added them back yet (or they're on a different IP than we stored).
      // Auto-create a peer entry so messages/files route correctly.
      // Uses a stable ID based on IP so repeated connections don't duplicate.
      if (!wanPeer && remoteIp) {
        const stableId = 'wand-auto-' + remoteIp.replace(/[.:]/g, '_');
        wanPeer = Array.from(this.peers.values()).find(p => p.id === stableId);
        if (!wanPeer) {
          wanPeer = this.addWanDirectPeer(
            stableId, remoteIp, socket.remotePort, remoteIp,
            { token: null, relayIp: null, relayPort: null }
          );
          console.log(`[wan] Auto-discovered incoming peer ${remoteIp}:${socket.remotePort}`);
        }
      }

      if (wanPeer) {
        this._handleWanNegotiation(socket, wanPeer).catch(() => {});
      }
      this.handleIncomingTransfer(socket);
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

  handleIncomingTransfer(socket) {
    let headerReceived = false;
    let fileInfo = null;
    let receivedBytes = 0;
    let fileStream = null;
    let headerBuffer = Buffer.alloc(0);
    const transferId = crypto.randomBytes(8).toString('hex');
    let startTime = null;
    let lastProgressEmit = 0;
    const peerIp = socket.remoteAddress;
    let pendingChunks = [];
    let transferComplete = false;

    // Store socket so we can cancel if declined
    this.activeTransfers.set(transferId, { socket });

    socket.on('data', (chunk) => {
      if (!headerReceived) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        
        // Look for header terminator (double newline)
        const headerEnd = headerBuffer.indexOf('\n\n');
        if (headerEnd !== -1) {
          const headerStr = headerBuffer.slice(0, headerEnd).toString();
          fileInfo = JSON.parse(headerStr);

          // Handle text-only messages — check BOTH type field and absence of filename
          if (fileInfo.type === 'typing') {
            this.emit('typing-received', { sender: fileInfo.sender || '', typing: !!fileInfo.typing, peerIp });
            socket.destroy();
            return;
          }
          if (fileInfo.type === 'reaction') {
            this.emit('reaction-received', { messageId: fileInfo.messageId, emoji: fileInfo.emoji, sender: fileInfo.sender, senderName: fileInfo.senderName, peerIp });
            socket.destroy();
            return;
          }
          if (fileInfo.type === 'read') {
            this.emit('read-receipt', { messageId: fileInfo.messageId, sender: fileInfo.sender, peerIp });
            socket.destroy();
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
            socket.destroy();
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
      console.error('Transfer socket error:', err);
      if (fileStream) {
        fileStream.end();
      }
      this.activeTransfers.delete(transferId);
    });
  }

  discardReceivedFile(transferId) {
    const transfer = this.activeTransfers.get(transferId);
    if (transfer && transfer.socket) {
      transfer.socket.destroy();
    }
    this.activeTransfers.set(transferId, { declined: true });
  }

  setSavePathForTransfer(transferId, savePath) {
    const existing = this.activeTransfers.get(transferId) || {};
    existing.savePath = savePath;
    existing.accepted = true;
    this.activeTransfers.set(transferId, existing);
  }

  setPendingThumbnail(filePath, thumbnail) {
    if (!this.pendingThumbnails) this.pendingThumbnails = new Map();
    this.pendingThumbnails.set(filePath, thumbnail);
  }

  // ── Socket factory ────────────────────────────────────────────
  // For LAN peers: plain TCP or TLS depending on config.
  // For WAN-direct peers: first-call negotiates hole-punch, caches result.
  //   Subsequent calls reuse the cached method or open fresh TCP.
  async _connectToPeer(peer, timeoutMs = 5000) {
    // ── WAN-direct path ──────────────────────────────────────
    if (peer.isWanDirect) {
      return this._connectWanPeer(peer, timeoutMs);
    }
    // ── LAN path ─────────────────────────────────────────────
    return this._connectTCP(peer, timeoutMs);
  }

  // Raw TCP/TLS connect (LAN and WAN TCP fallback)
  _connectTCP(peer, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const useTLS = this._encryptLAN && peer.encrypted;
      let socket;

      if (useTLS) {
        socket = tls.connect({
          host: peer.ip,
          port: peer.port,
          rejectUnauthorized: false,
          checkServerIdentity: () => undefined,
        });
        socket.once('secureConnect', () => {
          if (peer.tlsFingerprint) {
            const actualFp = socket.getPeerCertificate()?.fingerprint256;
            if (actualFp && actualFp !== peer.tlsFingerprint) {
              socket.destroy();
              reject(new Error(`TLS fingerprint mismatch for ${peer.username}`));
              return;
            }
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

  // WAN-direct connect: negotiate punch on first call, cache result
  async _connectWanPeer(peer, timeoutMs = 8000) {
    const cached = this._wanSessions.get(peer.id);

    // ── Cached relay stream: reuse (relay is stateful per UDP session) ──
    if (cached?.method === 'relay' && cached.stream && !cached.stream.destroyed) {
      return cached.stream;
    }

    // ── Step 1: Try direct TCP with a short timeout ──────────────
    // This is the fast path — if UPnP is working on both sides or the
    // peer is directly reachable, we connect immediately and skip all
    // the punch/relay machinery entirely.
    const TCP_PROBE_MS = 2500;
    const tcpSocket = await this._connectTCP(peer, TCP_PROBE_MS).catch(() => null);

    if (tcpSocket) {
      // TCP works — if we already cached this method, just return the socket
      if (cached?.method === 'tcp') return tcpSocket;

      // First successful TCP connection: record it and notify renderer
      // Don't run negotiation — TCP is already the best option here.
      this._wanSessions.set(peer.id, { method: 'tcp' });
      this.emit('wan-connection-method', { peerId: peer.id, method: 'tcp' });
      return tcpSocket;
    }

    // ── Step 2: TCP failed — try UDP hole-punch ──────────────────
    // Only attempt this if we haven't already cached a failed result.
    if (cached?.method === 'unreachable') {
      throw new Error(`${peer.username} is unreachable`);
    }

    console.log(`[wan] TCP to ${peer.ip}:${peer.port} failed, attempting hole-punch…`);

    // We need a TCP connection to negotiate the punch — try with the full timeout
    // on a second attempt in case the first probe was just too tight.
    const tcpForNegotiation = await this._connectTCP(peer, timeoutMs).catch(() => null);

    if (!tcpForNegotiation) {
      // Still no TCP — can't negotiate, try relay directly if we have it
      if (peer.token && peer.relayIp && peer.relayPort) {
        console.log(`[wan] No TCP, trying cold relay connect…`);
        const sessionId = require('./holepunch').generateSessionId();
        const rs = new RelayStream({
          relayIp:   peer.relayIp,
          relayPort: peer.relayPort,
          token:     peer.token,
          sessionId,
          localPort: this.transferPort + PUNCH_UDP_OFFSET + 10,
        });
        try {
          await rs.connect();
          this._wanSessions.set(peer.id, { method: 'relay', stream: rs });
          this.emit('wan-connection-method', { peerId: peer.id, method: 'relay' });
          return rs;
        } catch (e) {
          console.warn('[wan] Cold relay failed:', e.message);
        }
      }
      this._wanSessions.set(peer.id, { method: 'unreachable' });
      throw new Error(`Cannot reach ${peer.username} — TCP failed and no relay available`);
    }

    // ── Step 3: Negotiate over TCP — attempt punch, fall back to relay ──
    const localUdpPort = this.transferPort + PUNCH_UDP_OFFSET;

    const negotiator = new WanNegotiator(tcpForNegotiation, {
      isInitiator: true,
      localUdpPort,
      token:     peer.token    || null,
      relayIp:   peer.relayIp  || null,
      relayPort: peer.relayPort || null,
    });

    let result;
    try {
      result = await negotiator.negotiate();
    } catch (e) {
      console.warn('[punch] negotiate() threw:', e.message);
      result = { method: 'tcp' };
    }

    this._wanSessions.set(peer.id, result);
    this.emit('wan-connection-method', { peerId: peer.id, method: result.method });

    if (result.method === 'relay') return result.stream;

    // direct or tcp — TCP socket from negotiation is already connected
    return tcpForNegotiation;
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
    const header = JSON.stringify({ type: 'typing', typing: isTyping, sender: this.username }) + '\n\n';
    try {
      const socket = await this._connectToPeer(peer, 2000);
      socket.write(header);
      socket.end();
    } catch {}
  }

  async sendMessage(peerId, message, reply = null) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer not found');
    const encoded = Buffer.from(message, 'utf8').toString('base64');
    const payload = { type: 'message', message: encoded, encoding: 'base64', sender: this.username, senderAvatar: this.avatar };
    if (reply) payload.reply = reply;
    const header = JSON.stringify(payload) + '\n\n';
    const socket = await this._connectToPeer(peer);
    return new Promise((resolve, reject) => {
      socket.write(header);
      socket.end();
      socket.once('error', reject);
      resolve({ success: true });
    });
  }

  async sendReaction(peerId, messageId, emoji) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const payload = { type: 'reaction', messageId, emoji, sender: this.peerId, senderName: this.username };
    const header = JSON.stringify(payload) + '\n\n';
    try {
      const socket = await this._connectToPeer(peer, 3000);
      socket.write(header);
      socket.end();
    } catch (e) { console.warn('[sendReaction] failed:', e.message); }
  }

  async sendReadReceipt(peerId, messageId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const payload = { type: 'read', messageId, sender: this.peerId };
    const header = JSON.stringify(payload) + '\n\n';
    try {
      const socket = await this._connectToPeer(peer, 2000);
      socket.write(header);
      socket.end();
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

    const client = await this._connectToPeer(peer);
    client.setNoDelay(true);

    return new Promise((resolve, reject) => {
      client.write(header);

      const fileStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
      let sentBytes = 0, lastProgressEmit = 0, isPaused = false;

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
      client.on('drain', () => { if (isPaused) { fileStream.resume(); isPaused = false; } });
      fileStream.on('end', () => {
        client.end();
        this.emit('transfer-complete', { peerId, filename, size: fileStats.size, message, thumbnail });
        resolve({ success: true });
      });
      fileStream.on('error', (err) => { client.destroy(); reject(err); });
      client.on('error', reject);
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
      // Port in use — try next one
      await srv.listen(relayPort + 1);
    }
    // Restore any persisted tokens
    for (const token of this._issuedTokens.values()) srv.addToken(token);
    this._relayServer   = srv;
    this._relayPort     = srv.port;
    this._relayPublicIp = publicIp;
    // Map relay port via UPnP
    try { await upnpClient.addPortMappingWithFallback(this._relayPort, 'Edge-Relay'); } catch {}
    this.emit('relay-started', { ip: publicIp, port: this._relayPort });
    return this.getRelayEndpoint();
  }

  getRelayEndpoint() {
    if (!this._relayServer) return null;
    return { ip: this._relayPublicIp, port: this._relayPort };
  }

  isRelayAvailable() { return !!this._relayServer; }

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
  addWanDirectPeer(id, ip, port, label, { token, relayIp, relayPort } = {}) {
    const peer = {
      id,
      ip,
      port,
      username: label || `${ip}:${port}`,
      avatar: null,
      nickname: null,
      lastSeen: Date.now(),
      isWanDirect: true,
      token:     token    || null,   // auth token for relay
      relayIp:   relayIp  || null,   // relay host IP (if available)
      relayPort: relayPort || null,  // relay host UDP port
    };
    this.peers.set(id, peer);
    this.emit('peer-discovered', peer);
    return peer;
  }

  removeWanDirectPeer(id) {
    if (this.peers.has(id)) {
      this.revokeTokenForPeer(id);
      this._wanSessions.delete(id);
      this.peers.delete(id);
      this.emit('peer-left', id);
    }
  }

  // Keep WAN-direct peers "alive" — call periodically from main
  heartbeatWanDirectPeers() {
    for (const [id, peer] of this.peers) {
      if (peer.isWanDirect) peer.lastSeen = Date.now();
    }
  }
}

module.exports = NetworkManager;
