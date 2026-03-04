const WebTorrent = require('webtorrent');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

class WANManager extends EventEmitter {
  constructor() {
    super();
    this.privateClient = null;
    this.torrentClient = null;
    this.directServer = null;
    this.directPort = 45456;
    this.activeSends = new Map();
    this.activeReceives = new Map();
    this._initClients();
  }

  _initClients() {
    this.PRIVATE_PORT = 49152 + Math.floor(Math.random() * 1000); // fixed random port so we can embed it in magnet
    this.privateClient = new WebTorrent({ dht: false, lsd: false, natUpnp: true, webSeeds: false, torrentPort: this.PRIVATE_PORT });
    this.privateClient.on('error', (err) => console.error('Private client error:', err));
    this.torrentClient = new WebTorrent({ dht: true, lsd: true, tracker: { announce: [ 'wss://tracker.btorrent.xyz', 'wss://tracker.webtorrent.dev', 'udp://open.demonii.com:1337/announce', 'udp://tracker.openbittorrent.com:80/announce', 'udp://tracker.opentrackr.org:1337/announce' ] } });
    this.torrentClient.on('error', (err) => console.error('Torrent client error:', err));
  }

  async createPrivateSend(filePath) {
    return new Promise((resolve, reject) => {
      const filename = path.basename(filePath);
      this.privateClient.seed(filePath, { name: filename, announce: [] }, async (torrent) => {
        const infoHash = torrent.infoHash;
        const torrentPort = this.PRIVATE_PORT;
        const localIp = this.getLocalIP();
        const publicIp = await this.getPublicIP();
        // Local IP first - critical for same-network transfers
        // Most home routers don't support NAT hairpinning so public IP
        // won't work when both peers are on the same network
        const peers = [`${localIp}:${torrentPort}`];
        if (publicIp && publicIp !== localIp) peers.push(`${publicIp}:${torrentPort}`);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(filename)}`
          + peers.map(p => `&x.pe=${p}`).join(''); // x.pe must NOT be percent-encoded
        const info = { torrent, type: 'private', filename, size: torrent.length, infoHash, torrentPort, localIp, publicIp, peers };
        this.activeSends.set(infoHash, info);
        torrent.on('upload', () => this.emit('wan-progress', {
          infoHash, type: 'upload', uploaded: torrent.uploaded, speed: torrent.uploadSpeed,
          peers: torrent.numPeers, progress: torrent.length > 0 ? (torrent.uploaded / torrent.length * 100) : 0,
        }));
        torrent.on('error', (err) => this.emit('wan-error', { infoHash, error: err.message }));
        resolve({ magnetURI, infoHash, filename, size: torrent.length, mode: 'private', torrentPort, localIp, publicIp, peers });
      });
      setTimeout(() => reject(new Error('Timed out')), 30000);
    });
  }

  async createSemiPrivateSend(filePath) {
    return new Promise((resolve, reject) => {
      const filename = path.basename(filePath);
      this.torrentClient.seed(filePath, { name: filename, announce: [] }, (torrent) => {
        const infoHash = torrent.infoHash;
        this.activeSends.set(infoHash, { torrent, type: 'semi-private', filename, size: torrent.length, infoHash });
        torrent.on('upload', () => this.emit('wan-progress', {
          infoHash, type: 'upload', uploaded: torrent.uploaded, speed: torrent.uploadSpeed,
          peers: torrent.numPeers, progress: torrent.length > 0 ? (torrent.uploaded / torrent.length * 100) : 0,
        }));
        resolve({ magnetURI: torrent.magnetURI, infoHash, filename, size: torrent.length, mode: 'semi-private' });
      });
      setTimeout(() => reject(new Error('Timed out')), 30000);
    });
  }

  async receiveFromMagnet(magnetOrBuffer, savePath) {
    return new Promise((resolve, reject) => {
      const isBuffer = Buffer.isBuffer(magnetOrBuffer);
      const isDirectMagnet = !isBuffer && magnetOrBuffer.includes('x.pe=') && !magnetOrBuffer.includes('&tr=');
      const client = isDirectMagnet ? this.privateClient : this.torrentClient;
      const torrent = client.add(magnetOrBuffer, { path: savePath });
      const infoHash = torrent.infoHash;
      this.activeReceives.set(infoHash, { torrent, type: 'receive', filename: 'Fetching...', size: 0, infoHash });
      this.emit('wan-receive-started', { infoHash, filename: 'Connecting to peer...', size: 0 });
      torrent.on('metadata', () => {
        this.activeReceives.get(infoHash).filename = torrent.name;
        this.emit('wan-metadata', { infoHash, filename: torrent.name, size: torrent.length });
      });
      torrent.on('download', () => this.emit('wan-progress', {
        infoHash, type: 'download', downloaded: torrent.downloaded, speed: torrent.downloadSpeed,
        peers: torrent.numPeers, progress: torrent.progress * 100, timeRemaining: torrent.timeRemaining,
      }));
      torrent.on('done', () => {
        const filePath = path.join(savePath, torrent.files[0].path);
        this.activeReceives.delete(infoHash);
        this.emit('wan-complete', { infoHash, filename: torrent.name, path: filePath, size: torrent.length });
        resolve({ filename: torrent.name, path: filePath });
      });
      torrent.on('error', (err) => { this.activeReceives.delete(infoHash); reject(err); });
    });
  }

  async exportTorrentFile(infoHash, savePath) {
    const send = this.activeSends.get(infoHash);
    if (!send || !send.torrent) throw new Error('Transfer not found');
    const buf = send.torrent.torrentFile;
    if (!buf) throw new Error('Torrent not ready yet - wait a moment and try again');
    await fs.promises.writeFile(savePath, buf);
    return savePath;
  }

  async startDirectServer(onIncomingFile) {
    if (this.directServer) return this.directPort;
    return new Promise((resolve, reject) => {
      this.directServer = net.createServer((socket) => this._handleDirectSocket(socket, onIncomingFile));
      const tryBind = (port) => { this.directServer.listen(port, '0.0.0.0', () => { this.directPort = port; resolve(port); }); };
      this.directServer.on('error', (err) => { if (err.code === 'EADDRINUSE') tryBind(this.directPort + 1); else reject(err); });
      tryBind(this.directPort);
    });
  }

  _handleDirectSocket(socket, onIncomingFile) {
    const connId = 'direct-' + crypto.randomBytes(6).toString('hex');
    let headerBuf = Buffer.alloc(0), headerDone = false, fileStream = null;
    let bytesReceived = 0, fileInfo = null, savePath = null;
    socket.on('data', async (chunk) => {
      if (!headerDone) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const sep = headerBuf.indexOf('\n\n');
        if (sep === -1) return;
        headerDone = true;
        try { fileInfo = JSON.parse(headerBuf.slice(0, sep).toString()); } catch (e) { socket.destroy(); return; }
        const rest = headerBuf.slice(sep + 2);
        if (onIncomingFile) savePath = await onIncomingFile(connId, fileInfo, socket.remoteAddress);
        if (!savePath) { socket.write('no\n'); socket.destroy(); return; }
        socket.write('ok\n');
        fileStream = fs.createWriteStream(savePath);
        this.emit('wan-direct-incoming', { connId, filename: fileInfo.filename, size: fileInfo.size, savePath });
        if (rest.length > 0) { fileStream.write(rest); bytesReceived += rest.length; this._emitDirectProgress(connId, fileInfo, bytesReceived); }
      } else if (fileStream) { fileStream.write(chunk); bytesReceived += chunk.length; this._emitDirectProgress(connId, fileInfo, bytesReceived); }
    });
    socket.on('end', () => { if (fileStream) fileStream.end(() => this.emit('wan-direct-complete', { connId, filename: fileInfo?.filename, path: savePath, size: fileInfo?.size })); });
    socket.on('error', (err) => { if (fileStream) fileStream.destroy(); this.emit('wan-error', { connId, error: err.message }); });
  }

  _emitDirectProgress(connId, fileInfo, bytesReceived) {
    this.emit('wan-progress', { infoHash: connId, type: 'direct-download', downloaded: bytesReceived, progress: fileInfo.size > 0 ? (bytesReceived / fileInfo.size * 100) : 0, speed: 0, peers: 1 });
  }

  async sendViaDirect(ip, port, filePath) {
    return new Promise((resolve, reject) => {
      const filename = path.basename(filePath), size = fs.statSync(filePath).size;
      const connId = 'ds-' + crypto.randomBytes(6).toString('hex');
      const socket = net.connect(parseInt(port), ip);
      socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('Timed out')); });
      socket.on('connect', () => {
        socket.write(JSON.stringify({ filename, size }) + '\n\n');
        let respBuf = '';
        const onData = (chunk) => {
          respBuf += chunk.toString();
          const nl = respBuf.indexOf('\n');
          if (nl === -1) return;
          socket.removeListener('data', onData);
          if (respBuf.slice(0, nl).trim() !== 'ok') { socket.destroy(); reject(new Error('Declined')); return; }
          const rs = fs.createReadStream(filePath);
          let sent = 0;
          rs.on('data', (c) => { socket.write(c); sent += c.length; this.emit('wan-progress', { infoHash: connId, type: 'direct-upload', uploaded: sent, progress: size > 0 ? (sent / size * 100) : 0, speed: 0, peers: 1 }); });
          rs.on('end', () => { socket.end(); resolve({ filename, size }); });
          rs.on('error', (e) => { socket.destroy(); reject(e); });
        };
        socket.on('data', onData);
      });
      socket.on('error', (err) => reject(new Error('Connection failed: ' + err.message)));
    });
  }

  // ── Streaming HTTP server ─────────────────────────────────
  // Serves torrent file pieces via HTTP with Range support so
  // the <video> element can seek even in a partially-downloaded torrent.
  startStreamServer() {
    if (this._streamServer) return;
    this._streamServer = http.createServer((req, res) => {
      // URL: /stream/:infoHash/:fileIndex
      const m = req.url.match(/^\/stream\/([^/]+)\/(\d+)/);
      if (!m) { res.writeHead(404); res.end(); return; }
      const [, infoHash, fi] = m;
      const torrent = this.torrentClient?.get(infoHash);
      const file = torrent?.files?.[parseInt(fi)];
      if (!file) { res.writeHead(404); res.end('File not found'); return; }

      const size = file.length;
      const rangeHeader = req.headers.range;

      // MIME type
      const ext = file.name.split('.').pop().toLowerCase();
      const mime = { mp4:'video/mp4', webm:'video/webm', mkv:'video/x-matroska',
        mov:'video/quicktime', avi:'video/x-msvideo', m4v:'video/mp4',
        mp3:'audio/mpeg', flac:'audio/flac', ogg:'audio/ogg', wav:'audio/wav',
        m4a:'audio/mp4', aac:'audio/aac',
        jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp'
      }[ext] || 'application/octet-stream';

      if (rangeHeader) {
        const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
        const start = parseInt(startStr, 10);
        const end   = endStr ? parseInt(endStr, 10) : size - 1;
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range':  `bytes ${start}-${end}/${size}`,
          'Accept-Ranges':  'bytes',
          'Content-Length': chunkSize,
          'Content-Type':   mime,
        });
        // Also prioritise pieces around the seek point so playback starts fast
        try {
          const pieceLen  = torrent.pieceLength || 262144;
          const startPiece = Math.floor(start / pieceLen);
          const endPiece   = Math.min(Math.ceil(end / pieceLen), (torrent.pieces?.length || 1) - 1);
          const priorityEnd = Math.min(startPiece + 8, endPiece);
          torrent.critical(startPiece, priorityEnd);
        } catch {}
        const rs = file.createReadStream({ start, end });
        req.on('close', () => { try { rs.destroy(); } catch {} });
        rs.on('error', () => { try { res.end(); } catch {} });
        rs.pipe(res);
      } else {
        res.writeHead(200, { 'Content-Length': size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
        const rs = file.createReadStream();
        req.on('close', () => { try { rs.destroy(); } catch {} });
        rs.on('error', () => { try { res.end(); } catch {} });
        rs.pipe(res);
      }
    });
    this._streamServer.listen(0, '127.0.0.1', () => {
      this._streamPort = this._streamServer.address().port;
    });
  }

  getStreamUrl(infoHash, fileIndex) {
    if (!this._streamServer) this.startStreamServer();
    // Give server a moment to bind
    return new Promise((resolve) => {
      const check = () => {
        if (this._streamPort) resolve(`http://127.0.0.1:${this._streamPort}/stream/${infoHash}/${fileIndex}`);
        else setTimeout(check, 50);
      };
      check();
    });
  }

  // ── Torrent persistence ────────────────────────────────────
  loadPersistedTorrents(dataPath) {
    this._persistPath = dataPath;
    try {
      const raw = require('fs').readFileSync(dataPath, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (entry.magnet && entry.savePath) {
            this.addTorrent(entry.magnet, entry.savePath).catch(() => {});
          }
        }
      }
    } catch {} // file doesn't exist yet or is corrupt — that's fine
  }

  _persistTorrents() {
    if (!this._persistPath) return;
    try {
      const list = this.torrentClient.torrents.map(t => ({
        magnet:   t.magnetURI   || '',
        savePath: t.path        || '',
        name:     t.name        || '',
        infoHash: t.infoHash    || '',
      })).filter(e => e.magnet && e.savePath);
      require('fs').writeFileSync(this._persistPath, JSON.stringify(list, null, 2));
    } catch {}
  }

  setUserTrackers(trackers) {
    this.userTrackers = Array.isArray(trackers) ? trackers : [];
    // Recreate torrentClient with new trackers
    if (this.torrentClient) {
      // Apply to future torrents (existing ones keep current trackers)
      // We store for next addTorrent call
    }
  }

  async addTorrent(magnetOrHash, savePath) {
    return new Promise((resolve, reject) => {
      // Announce to user's custom trackers too
      const extraTrackers = this.userTrackers || [];
      this.torrentClient.add(magnetOrHash, { path: savePath, announce: extraTrackers }, (torrent) => {
        // Sequential-ish: prioritise the start of each file so streaming can begin quickly
        torrent.on('metadata', () => {
          try {
            for (const file of torrent.files) {
              // High-priority on first 5% of each file for fast stream start
              const startPiece = file._startPiece || 0;
              const endPiece   = file._endPiece   || 0;
              const priorityEnd = Math.min(startPiece + Math.ceil((endPiece - startPiece) * 0.05) + 2, endPiece);
              torrent.critical(startPiece, priorityEnd);
            }
          } catch {}
        });
        const infoHash = torrent.infoHash;
        // Cache tracker stats by listening to events — more reliable than reading internals
        if (!this._trackerStats) this._trackerStats = new Map();
        this._trackerStats.set(infoHash, { seeders: 0, leechers: 0, trackers: [] });
        torrent.on('warning', (err) => {
          // tracker warnings often contain announce URLs
        });
        // bittorrent-tracker emits 'update' on the discovery tracker
        if (torrent.discovery && torrent.discovery.tracker) {
          torrent.discovery.tracker.on('update', (data) => {
            if (!this._trackerStats) return;
            const stats = this._trackerStats.get(infoHash) || { seeders: 0, leechers: 0, trackers: [] };
            const url = String(data.announce || '');
            const complete   = Number(data.complete   || 0);
            const incomplete = Number(data.incomplete || 0);
            // Update or add this tracker's entry
            const existing = stats.trackers.find(t => t.url === url);
            if (existing) { existing.seeders = complete; existing.leechers = incomplete; }
            else if (url) stats.trackers.push({ url, seeders: complete, leechers: incomplete });
            // Sum totals
            stats.seeders  = stats.trackers.reduce((a, t) => a + t.seeders,  0);
            stats.leechers = stats.trackers.reduce((a, t) => a + t.leechers, 0);
            this._trackerStats.set(infoHash, stats);
          });
        }
        this.emit('torrent-added', { infoHash, name: torrent.name || 'Loading...', size: torrent.length || 0 });
        torrent.on('metadata', () => this._persistTorrents());
        torrent.on('metadata', () => this.emit('torrent-metadata', { infoHash, name: torrent.name, size: torrent.length, files: torrent.files.map(f => ({ name: f.name, size: f.length })) }));
        // Throttle progress events — fire at most every 600ms
        let lastProgressEmitTime = 0;
        let pendingProgressEmit = null;
        const ep = () => {
          const now = Date.now();
          if (pendingProgressEmit) return; // already one queued
          const delay = Math.max(0, 600 - (now - lastProgressEmitTime));
          pendingProgressEmit = setTimeout(() => {
            pendingProgressEmit = null;
            lastProgressEmitTime = Date.now();
            const _ts2 = this._trackerStats?.get(infoHash) || { seeders: 0, leechers: 0 };
            let totalSeeders  = Number(_ts2.seeders  || 0);
            let totalLeechers = Number(_ts2.leechers || 0);
            let _pc = 0;
            try { _pc = torrent.pieces ? torrent.pieces.filter(Boolean).length : 0; } catch {}
            this.emit('torrent-progress', {
              infoHash:      String(infoHash),
              name:          String(torrent.name          || ''),
              downloaded:    Number(torrent.downloaded    || 0),
              size:          Number(torrent.length        || 0),
              progress:      Number(torrent.progress      || 0) * 100,
              downloadSpeed: Number(torrent.downloadSpeed || 0),
              uploadSpeed:   Number(torrent.uploadSpeed   || 0),
              peers:         Number(torrent.numPeers      || 0),
              seeders:       Number(totalSeeders),
              leechers:      Number(totalLeechers),
              timeRemaining: Number(torrent.timeRemaining || Infinity),
              ratio:         Number(torrent.ratio         || 0),
              status:        torrent.done ? 'seeding' : 'downloading',
              pieces:        Number(torrent.pieces?.length || 0),
              piecesComplete: _pc,
            });
          }, delay);
        };
        torrent.on('download', ep); torrent.on('upload', ep);
        // Fallback: emit progress every 2s even if no download/upload events fire
        const progressInterval = setInterval(() => {
          if (torrent.destroyed) { clearInterval(progressInterval); return; }
          ep();
        }, 2000);
        torrent.on('done', () => clearInterval(progressInterval));
        torrent.on('done', () => this.emit('torrent-complete', { infoHash, name: torrent.name, path: savePath }));
        torrent.on('error', (err) => this.emit('torrent-error', { infoHash, error: err.message }));
        resolve({ infoHash, name: torrent.name || 'Loading...' });
      });
    });
  }

  setFilePriority(infoHash, fileIndex, priority) {
    const torrent = this.torrentClient.get(infoHash);
    if (!torrent || !torrent.files[fileIndex]) return { success: false };
    const file = torrent.files[fileIndex];
    if (priority === -1) {
      file.deselect(); // skip this file
    } else {
      file.select();   // download this file
    }
    return { success: true };
  }

  getFilePath(infoHash, fileIndex) {
    const torrent = this.torrentClient.get(infoHash);
    if (!torrent || !torrent.files[fileIndex]) return null;
    const file = torrent.files[fileIndex];
    return { path: file.path, name: file.name };
  }

  getTorrents() {
    return this.torrentClient.torrents.map(t => {
      // Use cached tracker stats from event listeners (reliable)
      const _ts = this._trackerStats?.get(t.infoHash) || { seeders: 0, leechers: 0, trackers: [] };
      let totalSeeders  = Number(_ts.seeders  || 0);
      let totalLeechers = Number(_ts.leechers || 0);
      const trackerList = (_ts.trackers || []).map(tr => ({ url: String(tr.url||''), seeders: Number(tr.seeders||0), leechers: Number(tr.leechers||0) }));
      // Fallback to connected peers if no tracker data yet
      if (totalSeeders === 0 && t.numPeers > 0) totalSeeders = t.numPeers;

      // Files — extract only plain values, never the File object itself
      const files = [];
      try {
        for (const f of (t.files || [])) {
          files.push({
            name:     String(f.name     || ''),
            path:     String(f.path     || ''),
            size:     Number(f.length   || 0),
            progress: Number(f.progress || 0) * 100,
            done:     Boolean(f.done),
          });
        }
      } catch {}

      // Pieces — avoid passing the whole SparseArray; just count
      let pieces = 0, piecesComplete = 0;
      try {
        pieces = Number(t.pieces?.length || 0);
        piecesComplete = t.pieces ? t.pieces.filter(Boolean).length : 0;
      } catch {}

      // Return only JSON-serialisable primitives
      return {
        infoHash:      String(t.infoHash      || ''),
        name:          String(t.name          || 'Loading...'),
        size:          Number(t.length        || 0),
        downloaded:    Number(t.downloaded    || 0),
        uploaded:      Number(t.uploaded      || 0),
        progress:      Number(t.progress      || 0) * 100,
        downloadSpeed: Number(t.downloadSpeed || 0),
        uploadSpeed:   Number(t.uploadSpeed   || 0),
        peers:         Number(t.numPeers      || 0),
        seeders:       totalSeeders,
        leechers:      totalLeechers,
        status:        t.done ? 'seeding' : (t.paused ? 'paused' : 'downloading'),
        ratio:         Number(t.ratio         || 0),
        timeRemaining: Number(t.timeRemaining || Infinity),
        trackers:      trackerList,
        files,
        pieces,
        piecesComplete,
        magnetURI:     String(t.magnetURI     || ''),
      };
    });
  }

  pauseTorrent(h) { const t = this.torrentClient.get(h); if (t) t.pause(); }
  resumeTorrent(h) { const t = this.torrentClient.get(h); if (t) t.resume(); }
  removeTorrent(h, d = false) { const t = this.torrentClient.get(h); if (t) t.destroy({ destroyStore: d }); }
  cancelWanSend(h) { const s = this.activeSends.get(h); if (s?.torrent) { s.torrent.destroy(); this.activeSends.delete(h); } }
  cancelWanReceive(h) { const r = this.activeReceives.get(h); if (r?.torrent) { r.torrent.destroy(); this.activeReceives.delete(h); } }

  async getPublicIP() {
    for (const svc of ['https://api.ipify.org', 'https://icanhazip.com']) {
      try { const r = await fetch(svc, { signal: AbortSignal.timeout(4000) }); const ip = (await r.text()).trim(); if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip; } catch {}
    }
    return null;
  }

  getLocalIP() {
    for (const name of Object.keys(os.networkInterfaces())) {
      for (const iface of os.networkInterfaces()[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
    return '127.0.0.1';
  }

  getActiveSends() {
    return Array.from(this.activeSends.values()).map(s => ({ infoHash: s.infoHash, filename: s.filename, size: s.size, type: s.type, uploaded: s.torrent?.uploaded ?? 0, speed: s.torrent?.uploadSpeed ?? 0, peers: s.torrent?.numPeers ?? 0, progress: (s.torrent && s.size > 0) ? (s.torrent.uploaded / s.size * 100) : 0 }));
  }

  getActiveReceives() {
    return Array.from(this.activeReceives.values()).map(r => ({ infoHash: r.infoHash, filename: r.filename, size: r.size, type: r.type, downloaded: r.torrent?.downloaded ?? 0, speed: r.torrent?.downloadSpeed ?? 0, peers: r.torrent?.numPeers ?? 0, progress: r.torrent ? r.torrent.progress * 100 : 0 }));
  }

  destroy() {
    if (this.privateClient) this.privateClient.destroy();
    if (this.torrentClient) this.torrentClient.destroy();
    if (this.directServer) this.directServer.close();
  }
}

module.exports = WANManager;
