'use strict';

const net    = require('net');
const dgram  = require('dgram');
const os     = require('os');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const DISCOVERY_PORT    = 42068;
const DEFAULT_DATA_PORT = 42069;
const DISCOVERY_INTERVAL = 3000;
const CHUNK_SIZE         = 512 * 1024;  // 512 KB -- much better for LAN throughput
const HANDSHAKE_TIMEOUT  = 5000;
const UPNP_TIMEOUT_MS    = 8000;
const UPNP_RETRIES       = 2;
const FILE_ACCEPT_TIMEOUT = 10 * 60 * 1000; // 10 min

// ── MIME ──────────────────────────────────────────────────────────────────────
const MIME_MAP = {
  jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif',
  webp:'image/webp', bmp:'image/bmp', svg:'image/svg+xml', ico:'image/x-icon',
  tiff:'image/tiff',
  mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime',
  mkv:'video/x-matroska', avi:'video/x-msvideo', m4v:'video/mp4',
  mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', flac:'audio/flac',
  pdf:'application/pdf',
  zip:'application/zip', gz:'application/gzip', '7z':'application/x-7z-compressed',
};
function detectMime(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getLocalIPs() {
  const ips = [];
  for (const iface of Object.values(os.networkInterfaces()))
    for (const a of iface)
      if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  return ips;
}

function getBroadcastAddresses() {
  const set = new Set(['255.255.255.255']);
  for (const iface of Object.values(os.networkInterfaces()))
    for (const a of iface)
      if (a.family === 'IPv4' && !a.internal) {
        const p = a.address.split('.').map(Number);
        const m = a.netmask.split('.').map(Number);
        set.add(p.map((b, i) => (b | (~m[i] & 0xff))).join('.'));
      }
  return Array.from(set);
}

function makeTempPath() {
  const dir = path.join(os.tmpdir(), 'edge-p2p');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, crypto.randomBytes(8).toString('hex') + '.tmp');
}

// ═══════════════════════════════════════════════════════════════════════════════
// FramedSocket -- length-prefixed framing with two frame types:
//
//   JSON frame   (type byte 0x00): [4-byte-len][0x00][JSON-or-AES(JSON)]
//   BINARY frame (type byte 0x01): [4-byte-len][0x01][4-byte-fileId][raw-or-AES(data)]
//
// Binary frames bypass base64+JSON for file chunks, removing the main
// throughput bottleneck (base64 inflates 64KB->87KB, JSON.stringify adds more,
// plus multiple Buffer.concat re-allocs per chunk = ~8.5 MB/s cap on LAN).
// ═══════════════════════════════════════════════════════════════════════════════
const FRAME_JSON   = 0x00;
const FRAME_BINARY = 0x01;

class FramedSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket  = socket;
    this._buf    = Buffer.alloc(0);
    this._aesKey = null;
    socket.on('data',  chunk => { this._buf = Buffer.concat([this._buf, chunk]); this._drain(); });
    socket.on('close', ()    => this.emit('close'));
    socket.on('error', err   => this.emit('error', err));
  }

  setEncryption(sharedSecret) {
    this._aesKey = crypto.createHash('sha256').update(sharedSecret).digest();
  }

  _drain() {
    while (this._buf.length >= 5) {
      const len = this._buf.readUInt32BE(0);      // length covers type byte + inner
      if (len > 68 * 1024 * 1024) { this.socket.destroy(); return; }
      if (this._buf.length < 4 + len) break;
      const frameType = this._buf[4];
      const inner     = this._buf.slice(5, 4 + len);
      this._buf = this._buf.slice(4 + len);

      try {
        if (frameType === FRAME_BINARY) {
          // Decrypt if needed, then split [4-byte fileId][chunk data]
          let payload;
          if (this._aesKey) {
            if (inner.length < 28) continue;
            const d = crypto.createDecipheriv('aes-256-gcm', this._aesKey, inner.slice(0, 12));
            d.setAuthTag(inner.slice(12, 28));
            payload = Buffer.concat([d.update(inner.slice(28)), d.final()]);
          } else {
            payload = inner;
          }
          if (payload.length < 4) continue;
          const fileId = payload.slice(0, 4).toString('hex');
          const data   = payload.slice(4);
          this.emit('binary-chunk', { fileId, data });
        } else {
          // Standard JSON frame
          let payload;
          if (this._aesKey) {
            if (inner.length < 28) continue;
            const d = crypto.createDecipheriv('aes-256-gcm', this._aesKey, inner.slice(0, 12));
            d.setAuthTag(inner.slice(12, 28));
            payload = Buffer.concat([d.update(inner.slice(28)), d.final()]);
          } else {
            payload = inner;
          }
          this.emit('message', JSON.parse(payload.toString('utf8')));
        }
      } catch (_) {}
    }
  }

  // Send a JSON control message (all non-chunk messages)
  send(obj) {
    if (this.socket.destroyed) return true;
    try {
      const json = Buffer.from(JSON.stringify(obj), 'utf8');
      let inner;
      if (this._aesKey) {
        const iv  = crypto.randomBytes(12);
        const c   = crypto.createCipheriv('aes-256-gcm', this._aesKey, iv);
        const enc = Buffer.concat([c.update(json), c.final()]);
        inner     = Buffer.concat([iv, c.getAuthTag(), enc]);
      } else {
        inner = json;
      }
      const hdr = Buffer.allocUnsafe(5);
      hdr.writeUInt32BE(1 + inner.length, 0);
      hdr[4] = FRAME_JSON;
      return this.socket.write(Buffer.concat([hdr, inner]));
    } catch (_) { return true; }
  }

  // Send a raw binary chunk -- no base64, no JSON.
  // fileIdHex: 8-char hex string (4 bytes).  data: Buffer of raw chunk bytes.
  sendBinary(fileIdHex, data) {
    if (this.socket.destroyed) return true;
    try {
      const idBuf = Buffer.from(fileIdHex, 'hex');   // 4 bytes
      let inner;
      if (this._aesKey) {
        const iv  = crypto.randomBytes(12);
        const c   = crypto.createCipheriv('aes-256-gcm', this._aesKey, iv);
        const enc = Buffer.concat([c.update(Buffer.concat([idBuf, data])), c.final()]);
        inner     = Buffer.concat([iv, c.getAuthTag(), enc]);
      } else {
        inner = Buffer.concat([idBuf, data]);
      }
      const hdr = Buffer.allocUnsafe(5);
      hdr.writeUInt32BE(1 + inner.length, 0);
      hdr[4] = FRAME_BINARY;
      return this.socket.write(Buffer.concat([hdr, inner]));
    } catch (_) { return true; }
  }

  // Wait for the socket to drain before writing more
  drain() {
    return new Promise(resolve => {
      if (this.socket.writableNeedDrain) {
        this.socket.once('drain', resolve);
      } else {
        resolve();
      }
    });
  }

  destroy() { this.socket.destroy(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NetworkManager
// ═══════════════════════════════════════════════════════════════════════════════
class NetworkManager extends EventEmitter {
  constructor(displayName, nodeId) {
    super();
    this.myId   = nodeId || crypto.randomBytes(6).toString('hex');
    this.myName = displayName || os.hostname();
    this.myProfilePic = null;  // set externally after construction
    this.dataPort   = DEFAULT_DATA_PORT;
    this.upnpPort   = null;
    this.externalIp = null;

    this.peers         = new Map();
    this.server        = null;
    this.udp           = null;
    this._discInterval = null;
    this._upnpClient   = null;

    // fileId → { tempPath, mime, name, size }  — pointer to disk file
    this._receivedFiles = new Map();
    // fileId → { writeStream, tempPath, name, size, mime, peerId, received }
    this._incoming      = new Map();
    // fileId → { resolve, reject } — sender waiting for accept/reject
    this._pendingSend   = new Map();
  }

  async start() {
    await this._startTCP();
    this._startUDP();
    this._tryUPnP();
  }

  // ── TCP ──────────────────────────────────────────────────────────────────────

  _startTCP() {
    return new Promise(resolve => {
      const tryPort = port => {
        const srv = net.createServer(sock => this._handleIncoming(sock));
        srv.once('error', e => { if (e.code === 'EADDRINUSE') tryPort(port + 1); });
        srv.listen(port, '0.0.0.0', () => {
          this.server = srv; this.dataPort = port;
          console.log(`[Edge] TCP :${port}`);
          resolve();
        });
      };
      tryPort(this.dataPort);
    });
  }

  _makeHandshake() {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return { ecdh, pubKeyHex: ecdh.getPublicKey('hex') };
  }

  _finishHandshake(framed, myEcdh, peerPubHex) {
    try {
      const secret = myEcdh.computeSecret(Buffer.from(peerPubHex, 'hex'));
      framed.setEncryption(secret);
      // Fingerprint = first 32 hex chars of SHA-256(sharedSecret) — human-readable identity check
      return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 32);
    }
    catch (e) { console.error('[Edge] ECDH failed:', e.message); framed.destroy(); return null; }
  }

  _handleIncoming(socket) {
    socket.setNoDelay(true);
    const framed = new FramedSocket(socket);
    const { ecdh, pubKeyHex } = this._makeHandshake();
    let peerId = null;
    const hst = setTimeout(() => { if (!peerId) socket.destroy(); }, HANDSHAKE_TIMEOUT);

    framed.on('message', msg => {
      if (!peerId) {
        if (msg.type !== 'handshake') { socket.destroy(); return; }
        clearTimeout(hst);
        peerId = msg.id;
        framed.send({ type:'handshake', id:this.myId, name:this.myName, listenPort:this.dataPort, ecdhPubKey:pubKeyHex, profilePic:this.myProfilePic||null });
        const fp = this._finishHandshake(framed, ecdh, msg.ecdhPubKey);
        this._registerPeer(peerId, { id:msg.id, name:msg.name, ip:socket.remoteAddress?.replace('::ffff:',''), port:msg.listenPort, lan:msg.lan??true, socket, framed, connected:true, messages:[], files:[], fingerprint:fp, profilePic:msg.profilePic||null });
      } else { this._handleMsg(peerId, msg); }
    });
    framed.on('binary-chunk', ({ fileId, data }) => { if (peerId) this._handleBinaryChunk(peerId, fileId, data); });
    framed.on('close', () => this._onPeerClose(peerId));
    framed.on('error', () => {});
  }

  connectToPeer(ip, port, lan = false) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host:ip, port:parseInt(port,10) }, () => {
        socket.setNoDelay(true);
        const framed = new FramedSocket(socket);
        const { ecdh, pubKeyHex } = this._makeHandshake();
        let peerId = null;
        const hst = setTimeout(() => { if (!peerId) { socket.destroy(); reject(new Error('Handshake timeout')); } }, HANDSHAKE_TIMEOUT);
        framed.send({ type:'handshake', id:this.myId, name:this.myName, listenPort:this.dataPort, lan, ecdhPubKey:pubKeyHex, profilePic:this.myProfilePic||null });
        framed.on('message', msg => {
          if (!peerId) {
            if (msg.type !== 'handshake') { socket.destroy(); reject(new Error('Bad handshake')); return; }
            clearTimeout(hst);
            peerId = msg.id;
            const fp = this._finishHandshake(framed, ecdh, msg.ecdhPubKey);
            this._registerPeer(peerId, { id:msg.id, name:msg.name, ip, port:msg.listenPort, lan, socket, framed, connected:true, messages:[], files:[], fingerprint:fp, profilePic:msg.profilePic||null });
            resolve(this._publicPeer(peerId));
          } else { this._handleMsg(peerId, msg); }
        });
        framed.on('binary-chunk', ({ fileId, data }) => { if (peerId) this._handleBinaryChunk(peerId, fileId, data); });
        framed.on('close', () => this._onPeerClose(peerId));
        framed.on('error', () => {});
      });
      socket.once('error', err => reject(err));
    });
  }

  // ── Peer registry ────────────────────────────────────────────────────────────

  _registerPeer(id, record) {
    const ex = this.peers.get(id);
    if (ex) {
      ex.socket      = record.socket;
      ex.framed      = record.framed;
      ex.connected   = true;
      ex.ip          = record.ip;
      // Always apply latest values from fresh handshake
      if (record.profilePic  !== undefined) ex.profilePic  = record.profilePic;
      if (record.fingerprint !== undefined) ex.fingerprint = record.fingerprint;
      this.emit('peer-reconnected', this._publicPeer(id));
    } else {
      this.peers.set(id, record);
      this.emit('peer-connected', this._publicPeer(id));
    }
  }

  _onPeerClose(peerId) {
    if (!peerId) return;
    const p = this.peers.get(peerId); if (!p) return;
    p.connected=false; p.socket=null; p.framed=null;
    // Reject any pending file sends to this peer
    for (const [fid, pending] of this._pendingSend) {
      if (pending.peerId === peerId) {
        this._pendingSend.delete(fid);
        pending.reject(new Error('Peer disconnected'));
      }
    }
    this.emit('peer-disconnected', peerId);
  }

  _publicPeer(id) {
    const p = this.peers.get(id); if (!p) return null;
    return { id:p.id, name:p.name, ip:p.ip, port:p.port, lan:p.lan,
             connected:p.connected, messages:p.messages,
             files:p.files.map(f=>({...f})), fingerprint:p.fingerprint||null,
             profilePic:p.profilePic||null };
  }

  // ── Message dispatch ─────────────────────────────────────────────────────────

  _handleMsg(peerId, msg) {
    const peer = this.peers.get(peerId); if (!peer) return;

    switch (msg.type) {

      case 'chat': {
        const m = { id:msg.id, text:msg.text, timestamp:msg.timestamp, from:'them',
                    replyTo: msg.replyTo || null };
        peer.messages.push(m);
        this.emit('message-received', { peerId, message:m });
        break;
      }

      case 'profile_update': {
        const peer = this.peers.get(peerId);
        if (peer) {
          peer.profilePic = msg.profilePic || null;
          this.emit('peer-profile-updated', { peerId, profilePic: peer.profilePic });
        }
        break;
      }

      case 'reaction': {
        this.emit('reaction-received', { peerId, msgId: msg.msgId, emoji: msg.emoji });
        break;
      }

      // ── File request/accept/reject handshake ──────────────────────────────────
      // Receiver gets file_request → asks user → replies file_accept or file_reject
      // No bytes flow until file_accept is received by sender.

      case 'file_request': {
        // Emit upward so app can ask user; app replies via acceptFileRequest()/rejectFileRequest()
        this.emit('file-request', {
          peerId,
          fileId: msg.fileId,
          name:   msg.name,
          size:   msg.size,
          mime:   msg.mime || 'application/octet-stream',
        });
        break;
      }

      case 'file_accept': {
        // Sender receives this — resolves the pending promise so streaming begins
        const pending = this._pendingSend.get(msg.fileId);
        if (pending) {
          this._pendingSend.delete(msg.fileId);
          pending.resolve();
        }
        break;
      }

      case 'file_reject': {
        const pending = this._pendingSend.get(msg.fileId);
        if (pending) {
          this._pendingSend.delete(msg.fileId);
          pending.reject(new Error('File rejected by receiver'));
        }
        this.emit('file-rejected-by-peer', { peerId, fileId: msg.fileId });
        break;
      }

      // ── File streaming (only after file_accept) ───────────────────────────────

      case 'file_start': {
        const tempPath = makeTempPath();
        let ws;
        try { ws = fs.createWriteStream(tempPath); }
        catch (e) { console.error('[Edge] Cannot create temp file:', e.message); break; }

        this._incoming.set(msg.fileId, {
          writeStream: ws, tempPath,
          name: msg.name, size: msg.size,
          mime: msg.mime || 'application/octet-stream',
          peerId, received: 0,
          startTime: Date.now(),   // preserve original start time for sorting
        });
        this.emit('file-progress', { peerId, fileId:msg.fileId, name:msg.name, received:0, size:msg.size });
        break;
      }

      case 'file_chunk': {
        // Legacy fallback: old clients still send base64 JSON chunks
        const t = this._incoming.get(msg.fileId);
        if (t) {
          const chunk = Buffer.from(msg.chunk, 'base64');
          t.writeStream.write(chunk);
          t.received += chunk.length;
          this.emit('file-progress', { peerId, fileId:msg.fileId, received:t.received, size:t.size });
        }
        break;
      }

      case 'file_end': {
        const t = this._incoming.get(msg.fileId);
        if (t) {
          this._incoming.delete(msg.fileId);
          t.writeStream.end(() => {
            this._receivedFiles.set(msg.fileId, {
              tempPath: t.tempPath, mime: t.mime, name: t.name, size: t.size,
            });
            const rec = { fileId:msg.fileId, name:t.name, size:t.size, mime:t.mime, from:'them',
                          timestamp: t.startTime };  // use start time, not end time
            peer.files.push(rec);
            this.emit('file-received', { peerId, file:rec });
          });
        }
        break;
      }
    }
  }

  // ── Binary chunk handler (fast path for file data) ───────────────────────────

  _handleBinaryChunk(peerId, fileId, data) {
    const t = this._incoming.get(fileId);
    if (!t) return;
    t.writeStream.write(data);
    t.received += data.length;
    this.emit('file-progress', { peerId, fileId, received:t.received, size:t.size });
  }

  // ── Accept / reject file requests (called by app layer) ──────────────────────

  acceptFileRequest(peerId, fileId) {
    const peer = this.peers.get(peerId);
    if (!peer?.framed) return;
    peer.framed.send({ type:'file_accept', fileId });
  }

  rejectFileRequest(peerId, fileId) {
    const peer = this.peers.get(peerId);
    if (!peer?.framed) return;
    peer.framed.send({ type:'file_reject', fileId });
  }

  // ── Send ─────────────────────────────────────────────────────────────────────

  sendMessage(peerId, text, replyTo = null) {
    const peer = this.peers.get(peerId);
    if (!peer?.framed) throw new Error('Peer not connected');
    const msg   = { type:'chat', id:crypto.randomBytes(4).toString('hex'), text, timestamp:Date.now(),
                    replyTo: replyTo || undefined };
    peer.framed.send(msg);
    const local = { id:msg.id, text, timestamp:msg.timestamp, from:'me', replyTo: replyTo||null };
    peer.messages.push(local);
    return local;
  }

  sendReaction(peerId, msgId, emoji) {
    const peer = this.peers.get(peerId);
    if (!peer?.framed) throw new Error('Peer not connected');
    peer.framed.send({ type:'reaction', msgId, emoji });
  }

  // Broadcast updated profile pic to all connected peers
  broadcastProfilePic(dataUrl) {
    this.myProfilePic = dataUrl || null;
    for (const peer of this.peers.values()) {
      if (peer.connected && peer.framed)
        peer.framed.send({ type:'profile_update', profilePic: this.myProfilePic });
    }
  }

  async sendFile(peerId, filePath, fileId = null) {
    const peer = this.peers.get(peerId);
    if (!peer?.framed) throw new Error('Peer not connected');

    const stat = fs.statSync(filePath);
    const name = path.basename(filePath);
    const size = stat.size;
    const mime = detectMime(name);
    if (!fileId) fileId = crypto.randomBytes(4).toString('hex');

    // ── Step 1: send request and wait for accept/reject ──────────────────────
    peer.framed.send({ type:'file_request', fileId, name, size, mime });

    await new Promise((resolve, reject) => {
      const tid = setTimeout(() => {
        this._pendingSend.delete(fileId);
        reject(new Error('File request timed out — receiver did not respond'));
      }, FILE_ACCEPT_TIMEOUT);

      this._pendingSend.set(fileId, {
        peerId,
        resolve: () => { clearTimeout(tid); resolve(); },
        reject:  (e) => { clearTimeout(tid); reject(e);  },
      });
    });

    // ── Step 2: accepted — stream the file ───────────────────────────────────
    const sendStartTime = Date.now();
    peer.framed.send({ type:'file_start', fileId, name, size, mime });

    const fd = fs.openSync(filePath, 'r');
    let offset = 0;
    let chunksSinceYield = 0;
    try {
      while (offset < size) {
        const toRead = Math.min(CHUNK_SIZE, size - offset);
        const buf    = Buffer.allocUnsafe(toRead);
        fs.readSync(fd, buf, 0, toRead, offset);
        // Use binary frame -- no base64, no JSON, no re-allocs
        const ok = peer.framed.sendBinary(fileId, buf);
        offset += toRead;
        this.emit('file-progress', { peerId, fileId, name, received:offset, size, fromSender:true });
        if (!ok) {
          await peer.framed.drain();
          chunksSinceYield = 0;
        } else if (++chunksSinceYield >= 8) {
          // Yield every ~4 MB (8 x 512 KB) so UI stays responsive
          await new Promise(r => setImmediate(r));
          chunksSinceYield = 0;
        }
      }
    } finally { fs.closeSync(fd); }

    peer.framed.send({ type:'file_end', fileId });
    const rec = { fileId, name, size, mime, from:'me', timestamp: sendStartTime };
    peer.files.push(rec);
    return rec;
  }

  // ── LAN Discovery ────────────────────────────────────────────────────────────

  _startUDP() {
    this.udp = dgram.createSocket({ type:'udp4', reuseAddr:true });
    this.udp.on('error', e => console.warn('[Edge] UDP:', e.message));
    this.udp.on('message', (raw, rinfo) => {
      try {
        const d = JSON.parse(raw.toString('utf8'));
        if (d.service !== 'edge-p2p' || d.id === this.myId) return;
        if (this.peers.get(d.id)?.connected) return;
        this.connectToPeer(rinfo.address, d.port, true).catch(() => {});
      } catch (_) {}
    });
    this.udp.bind(DISCOVERY_PORT, () => {
      try { this.udp.setBroadcast(true); } catch (_) {}
      this._broadcast();
      this._discInterval = setInterval(() => this._broadcast(), DISCOVERY_INTERVAL);
    });
  }

  _broadcast() {
    const msg = Buffer.from(JSON.stringify({ service:'edge-p2p', id:this.myId, name:this.myName, port:this.dataPort }));
    for (const addr of getBroadcastAddresses())
      this.udp.send(msg, 0, msg.length, DISCOVERY_PORT, addr, () => {});
  }

  // ── UPnP ─────────────────────────────────────────────────────────────────────

  _upnpCall(fn) {
    return new Promise((res, rej) => {
      const tid = setTimeout(() => rej(new Error('UPnP timeout')), UPNP_TIMEOUT_MS);
      fn((err, r) => { clearTimeout(tid); err ? rej(err) : res(r); });
    });
  }

  async _tryUPnP() {
    let upnp;
    try { upnp = require('nat-upnp'); }
    catch (_) { this.emit('upnp-status', { success:false, reason:'nat-upnp not installed' }); return; }

    for (let i = 1; i <= UPNP_RETRIES; i++) {
      try { this._upnpClient?.close?.(); } catch (_) {}
      const client = upnp.createClient();
      this._upnpClient = client;
      try {
        // Try dataPort first, then dataPort+1..+9 in case another instance has it mapped
        let mapped = false;
        for (let portOffset = 0; portOffset < 10; portOffset++) {
          const publicPort = this.dataPort + portOffset;
          await this._upnpCall(cb => client.portUnmapping({ public: publicPort }, cb)).catch(() => {});
          try {
            await this._upnpCall(cb => client.portMapping({
              public:  publicPort,
              private: this.dataPort,   // always forward to our actual listening port
              ttl: 3600, description: 'Edge P2P',
            }, cb));
            this.upnpPort = publicPort;
            mapped = true;
            break;
          } catch (_) {
            // This public port is taken — try next
          }
        }
        if (!mapped) throw new Error('All UPnP ports taken');

        const extIp = await this._upnpCall(cb => client.externalIp(cb));
        this.externalIp = extIp;
        this.emit('upnp-status', { success:true, port:this.upnpPort, ip:extIp });
        return;
      } catch (err) {
        console.warn(`[Edge] UPnP attempt ${i}: ${err.message}`);
        if (i === UPNP_RETRIES) this.emit('upnp-status', { success:false, reason:err.message });
        else await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  // ── Public ───────────────────────────────────────────────────────────────────

  getPeers() { return Array.from(this.peers.values()).map(p => this._publicPeer(p.id)); }

  getMyInfo() {
    return { id:this.myId, name:this.myName, port:this.dataPort,
             upnpPort:this.upnpPort, externalIp:this.externalIp, localIps:getLocalIPs() };
  }

  cleanupFile(fileId) {
    const s = this._receivedFiles.get(fileId);
    if (s?.tempPath) { try { fs.unlinkSync(s.tempPath); } catch (_) {} }
    this._receivedFiles.delete(fileId);
  }

  stop() {
    if (this._discInterval) clearInterval(this._discInterval);
    try { this.udp?.close(); } catch (_) {}
    try { this.server?.close(); } catch (_) {}
    if (this._upnpClient && this.upnpPort)
      this._upnpClient.portUnmapping({ public:this.upnpPort }, () => {});
    for (const [id] of this._receivedFiles) this.cleanupFile(id);
    for (const [, t] of this._incoming) {
      try { t.writeStream.destroy(); fs.unlinkSync(t.tempPath); } catch (_) {}
    }
    for (const [, p] of this._pendingSend) {
      p.reject(new Error('Application closing'));
    }
  }
}

module.exports = { NetworkManager, detectMime };
