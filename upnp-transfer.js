/**
 * upnp-transfer.js — Direct TCP file transfer over UPnP-mapped port.
 * Sender:   open local TCP server → UPnP maps external port → share code
 * Receiver: connect to sender's public IP:port → stream file
 *
 * Code format:  U~{ip}~{port}~{b62(filename)}
 * Example:      U~142.251.38.104~49201~3Kf9m   (~30 chars)
 */

'use strict';

const net    = require('net');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const { UPnPClient, getLocalIp } = require('./upnp-client');
const { EventEmitter } = require('events');

const CHUNK = 64 * 1024;

// ── Code encode/decode (simple — no BigInt needed, just base64url) ──
function encodeCode(ip, port, filename) {
  const fnB64 = Buffer.from(filename, 'utf8').toString('base64url');
  return `U~${ip}~${port}~${fnB64}`;
}

function decodeCode(code) {
  if (!code.startsWith('U~')) throw new Error('Not a UPnP transfer code');
  const [, ip, portStr, fnB64] = code.split('~');
  if (!ip || !portStr || !fnB64) throw new Error('Malformed transfer code');
  return { ip, port: parseInt(portStr), filename: Buffer.from(fnB64, 'base64url').toString('utf8') };
}

// ── UPnPTransfer ──────────────────────────────────────────────
class UPnPTransfer extends EventEmitter {
  constructor() {
    super();
    this._server    = null;
    this._upnp      = null;
    this._mappedPort = null;
  }

  // ── SENDER: open server, map port, return code ────────────
  async initSend(filePath) {
    const filename = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;

    // 1. Find a free local port
    const localPort = await this._getFreePort();

    // 2. UPnP map it
    this._upnp = new UPnPClient();
    let publicIp, externalPort;
    try {
      await this._upnp.init(5000);
      const mapping = await this._upnp.addPortMappingWithFallback(localPort, 'EdgeShare');
      externalPort = mapping.externalPort;
      publicIp = await this._upnp.getExternalIP();
    } catch (err) {
      throw new Error('UPnP failed: ' + err.message);
    }

    // 3. Start local TCP server
    await this._startServer(localPort, filePath, filename, fileSize);

    this._mappedPort = externalPort;
    const code = encodeCode(publicIp, externalPort, filename);
    this.emit('codeReady', code, filename, fileSize);
    return code;
  }

  _startServer(localPort, filePath, filename, fileSize) {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => {
        this._handleConnection(socket, filePath, filename, fileSize);
      });
      this._server.on('error', reject);
      this._server.listen(localPort, '0.0.0.0', resolve);
    });
  }

  _handleConnection(socket, filePath, filename, fileSize) {
    this.emit('connected');
    socket.setNoDelay(true);

    // Send header JSON + \n\n
    const header = JSON.stringify({ filename, size: fileSize }) + '\n\n';
    socket.write(header);

    // Wait for "ok\n" from receiver
    let resp = '';
    const onData = (chunk) => {
      resp += chunk.toString();
      if (!resp.includes('\n')) return;
      socket.removeListener('data', onData);
      if (!resp.trim().startsWith('ok')) {
        this.emit('declined');
        socket.destroy();
        return;
      }
      // Stream file
      this._streamFile(socket, filePath, fileSize);
    };
    socket.on('data', onData);
    socket.on('error', (err) => this.emit('error', err));
  }

  _streamFile(socket, filePath, fileSize) {
    const rs = fs.createReadStream(filePath, { highWaterMark: CHUNK });
    let sent = 0;
    let isPaused = false;

    rs.on('data', (chunk) => {
      const ok = socket.write(chunk);
      sent += chunk.length;
      this.emit('progress', { sent, total: fileSize, pct: fileSize ? sent / fileSize * 100 : 0 });
      if (!ok && !isPaused) { rs.pause(); isPaused = true; }
    });
    socket.on('drain', () => { if (isPaused) { rs.resume(); isPaused = false; } });
    rs.on('end', () => {
      socket.end();
      this.emit('done', { size: fileSize });
      this.cleanup();
    });
    rs.on('error', (err) => { socket.destroy(); this.emit('error', err); });
    socket.on('error', () => rs.destroy());
  }

  // ── RECEIVER: connect to sender ───────────────────────────
  async initReceive(code, savePath) {
    const { ip, port, filename } = decodeCode(code);
    this.emit('connecting', { ip, port, filename });

    return new Promise((resolve, reject) => {
      const socket = net.connect(port, ip);
      socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('Connection timed out')); });

      let headerBuf = '', headerDone = false, fileStream = null;
      let received = 0, fileInfo = null;

      socket.on('connect', () => {
        socket.setTimeout(0);
        this.emit('connected');
      });

      socket.on('data', async (chunk) => {
        if (!headerDone) {
          headerBuf += chunk.toString('binary');
          const sep = headerBuf.indexOf('\n\n');
          if (sep === -1) return;
          headerDone = true;
          try { fileInfo = JSON.parse(headerBuf.slice(0, sep)); } catch { socket.destroy(); reject(new Error('Bad header')); return; }

          this.emit('receiveStart', fileInfo);

          // Respond ok
          socket.write('ok\n');

          // Open write stream
          const finalPath = path.join(savePath, fileInfo.filename);
          fileStream = fs.createWriteStream(finalPath);
          fileStream.on('drain', () => socket.resume());

          // Write spillover bytes that came with the header
          const spillover = Buffer.from(headerBuf.slice(sep + 2), 'binary');
          if (spillover.length > 0) {
            received += spillover.length;
            if (!fileStream.write(spillover)) socket.pause();
            this.emit('progress', { received, total: fileInfo.size, pct: fileInfo.size ? received / fileInfo.size * 100 : 0 });
          }
        } else {
          if (!fileStream) return;
          received += chunk.length;
          if (!fileStream.write(chunk)) socket.pause();
          this.emit('progress', { received, total: fileInfo.size, pct: fileInfo.size ? received / fileInfo.size * 100 : 0 });
        }
      });

      socket.on('end', () => {
        if (fileStream) {
          fileStream.end(() => {
            const fp = path.join(savePath, fileInfo.filename);
            this.emit('done', { filename: fileInfo.filename, size: fileInfo.size, path: fp });
            resolve({ filename: fileInfo.filename, path: fp });
          });
        } else {
          reject(new Error('Connection closed before transfer started'));
        }
      });

      socket.on('error', reject);
    });
  }

  // ── Helpers ───────────────────────────────────────────────
  _getFreePort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '0.0.0.0', () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  }

  async cleanup() {
    try { this._server?.close(); } catch {}
    try { if (this._upnp && this._mappedPort) await this._upnp.removePortMapping(this._mappedPort); } catch {}
    this._server = null;
  }
}

module.exports = { UPnPTransfer, decodeCode, encodeCode };
