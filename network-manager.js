const dgram = require('dgram');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

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
    this.peerId = this.config.peerId; // Persistent ID
    this.avatar = this.config.avatar || null; // Base64 avatar
    this.favorites = this.config.favorites || {}; // Map of peerId -> nickname
    this.broadcastSocket = null;
    this.transferServer = null;
    this.transferPort = TRANSFER_PORT_START;
    this.activeTransfers = new Map();
  }

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

  startBroadcast() {
    this.broadcastSocket = dgram.createSocket('udp4');
    
    this.broadcastSocket.on('error', (err) => {
      console.error('Broadcast socket error:', err);
    });

    this.broadcastSocket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        
        // Ignore our own broadcasts
        if (data.peerId === this.peerId) {
          return;
        }

        // Update or add peer
        const peer = {
          id: data.peerId,
          username: data.username,
          ip: rinfo.address,
          port: data.transferPort,
          avatar: data.avatar || null,
          nickname: this.getFavoriteNickname(data.peerId),
          lastSeen: Date.now()
        };

        const isNewPeer = !this.peers.has(peer.id);
        this.peers.set(peer.id, peer);

        if (isNewPeer) {
          this.emit('peer-discovered', peer);
        }
      } catch (err) {
        // Ignore malformed messages
      }
    });

    this.broadcastSocket.bind(BROADCAST_PORT, () => {
      this.broadcastSocket.setBroadcast(true);
      console.log(`Listening for broadcasts on port ${BROADCAST_PORT}`);
      
      // Start broadcasting our presence
      this.broadcastInterval = setInterval(() => {
        this.sendBroadcast();
      }, BROADCAST_INTERVAL);
      
      // Send initial broadcast
      this.sendBroadcast();
    });
  }

  sendBroadcast() {
    const message = JSON.stringify({
      peerId: this.peerId,
      username: this.username,
      transferPort: this.transferPort,
      avatar: this.avatar
    });

    const buffer = Buffer.from(message);
    this.broadcastSocket.send(buffer, 0, buffer.length, BROADCAST_PORT, '255.255.255.255');
  }

  startPeerTimeout() {
    this.peerTimeoutInterval = setInterval(() => {
      const now = Date.now();
      for (const [peerId, peer] of this.peers.entries()) {
        if (now - peer.lastSeen > PEER_TIMEOUT) {
          this.peers.delete(peerId);
          this.emit('peer-left', peerId);
        }
      }
    }, 2000);
  }

  startTransferServer() {
    this.transferServer = net.createServer((socket) => {
      this.handleIncomingTransfer(socket);
    });

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

  async sendTyping(peerId, isTyping) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const header = JSON.stringify({ type: 'typing', typing: isTyping, sender: this.username }) + '\n\n';
    const client = new (require('net').Socket)();
    client.connect(peer.port, peer.ip, () => { client.write(header); client.end(); });
    client.on('error', () => {});
    client.setTimeout(2000, () => client.destroy());
  }

  async sendMessage(peerId, message, reply = null) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer not found');
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      // base64-encode message so it can never contain the \n\n delimiter
      const encoded = Buffer.from(message, 'utf8').toString('base64');
      const payload = { type: 'message', message: encoded, encoding: 'base64', sender: this.username, senderAvatar: this.avatar };
      if (reply) payload.reply = reply;
      const header = JSON.stringify(payload) + '\n\n';
      client.connect(peer.port, peer.ip, () => { client.write(header); client.end(); resolve({ success: true }); });
      client.on('error', reject);
      client.setTimeout(5000, () => { client.destroy(); reject(new Error('Timeout')); });
    });
  }

  async sendFile(peerId, filePath, message = '') {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error('Peer not found');
    }

    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      const fileStats = fs.statSync(filePath);
      const filename = path.basename(filePath);
      
      let thumbnail = null;
      const ext = filename.split('.').pop().toLowerCase();
      if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) {
        try {
          const imageData = fs.readFileSync(filePath);
          const base64 = imageData.toString('base64');
          if (base64.length < 800000) {
            thumbnail = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${base64}`;
          }
        } catch (err) { console.error('Thumbnail error:', err); }
      } else if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'wmv', 'flv'].includes(ext)) {
        // Check if renderer already extracted a real thumbnail for us
        const extracted = this.pendingThumbnails?.get(filePath);
        if (extracted) {
          thumbnail = extracted;
          this.pendingThumbnails.delete(filePath);
        } else {
          thumbnail = `__video__:${ext}`;
        }
      }
      
      // Prepare header with message and thumbnail
      const header = JSON.stringify({
        filename: filename,
        size: fileStats.size,
        message: message,
        thumbnail: thumbnail,
        sender: this.username,
        senderAvatar: this.avatar
      }) + '\n\n';

      client.connect(peer.port, peer.ip, () => {
        // Disable Nagle's algorithm for more accurate progress
        client.setNoDelay(true);
        
        // Send header
        client.write(header);
        
        // Stream file with backpressure handling
        const fileStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 }); // 64KB chunks
        let sentBytes = 0;
        let lastProgressEmit = 0;
        const startTime = Date.now();
        let isPaused = false;

        fileStream.on('data', (chunk) => {
          // Write returns false if buffer is full
          const canContinue = client.write(chunk);
          sentBytes += chunk.length;
          
          // Throttle to every 100ms
          const now = Date.now();
          if (now - lastProgressEmit >= 100) {
            this.emit('transfer-progress', {
              peerId,
              filename,
              sentBytes,
              totalBytes: fileStats.size,
              progress: (sentBytes / fileStats.size) * 100
            });
            lastProgressEmit = now;
          }
          
          // Pause reading if network buffer is full (backpressure)
          if (!canContinue && !isPaused) {
            fileStream.pause();
            isPaused = true;
          }
        });

        // Resume when network buffer drains
        client.on('drain', () => {
          if (isPaused) {
            fileStream.resume();
            isPaused = false;
          }
        });

        fileStream.on('end', () => {
          client.end();
          this.emit('transfer-complete', {
            peerId,
            filename,
            size: fileStats.size,
            message,
            thumbnail
          });
          resolve({ success: true });
        });

        fileStream.on('error', (err) => {
          client.destroy();
          reject(err);
        });
      });

      client.on('error', (err) => {
        reject(err);
      });
    });
  }

  getPeers() {
    return Array.from(this.peers.values());
  }
}

module.exports = NetworkManager;
