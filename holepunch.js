/**
 * holepunch.js — UDP hole-punch + token-gated relay for Edge
 *
 * Negotiation happens over an already-open TCP control socket.
 * Both sides exchange a JSON punch-offer, attempt UDP simultaneously,
 * then either promote to direct UDP, fall back to relay, or stay on TCP.
 */

'use strict';

const dgram  = require('dgram');
const crypto = require('crypto');
const stream = require('stream');
const { EventEmitter } = require('events');

const PUNCH_INTERVAL_MS = 200;
const PUNCH_TIMEOUT_MS  = 3500;
const RELAY_PORT_OFFSET = 2;
const PUNCH_UDP_OFFSET  = 1;
const PUNCH_MAGIC       = Buffer.from('EDGEPUNCH\x00');
const RELAY_MAGIC       = Buffer.from('EDGERELAY\x00');
const SESSION_ID_LEN    = 24;
const RELAY_HDR_LEN     = RELAY_MAGIC.length + SESSION_ID_LEN; // 34 bytes

function generateToken()    { return crypto.randomBytes(12).toString('hex'); }
function generateSessionId(){ return crypto.randomBytes(12).toString('hex'); }

// ── RelayServer ───────────────────────────────────────────────
class RelayServer extends EventEmitter {
  constructor() {
    super();
    this._socket      = null;
    this._port        = null;
    this._validTokens = new Set();
    this._sessions    = new Map(); // sessionId(hex) → [rinfo|null, rinfo|null]
  }

  async listen(port) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.once('error', reject);
      sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
      sock.bind(port, () => { this._socket = sock; this._port = sock.address().port; resolve(this._port); });
    });
  }

  addToken(token)    { this._validTokens.add(token); }
  removeToken(token) { this._validTokens.delete(token); }
  hasToken(token)    { return this._validTokens.has(token); }
  get port()         { return this._port; }

  registerSession(sessionId) {
    if (!this._sessions.has(sessionId)) this._sessions.set(sessionId, [null, null]);
  }

  _onMessage(msg, rinfo) {
    if (msg.length < RELAY_HDR_LEN) return;
    if (!msg.slice(0, RELAY_MAGIC.length).equals(RELAY_MAGIC)) return;

    const rawSession = msg.slice(RELAY_MAGIC.length, RELAY_HDR_LEN);
    const sessionId  = rawSession.toString('hex');
    const payload    = msg.slice(RELAY_HDR_LEN);

    // Auth frame: 0x01, tokenLen, token...
    if (payload.length >= 2 && payload[0] === 0x01) {
      const tokenLen = payload[1];
      if (payload.length < 2 + tokenLen) return;
      const token = payload.slice(2, 2 + tokenLen).toString('ascii');
      if (!this._validTokens.has(token)) {
        this.emit('relay-rejected', { rinfo, reason: 'invalid-token' });
        return;
      }
      this._joinSession(sessionId, rinfo);
      // ACK
      const ack = Buffer.concat([RELAY_MAGIC, rawSession]);
      this._socket.send(ack, rinfo.port, rinfo.address);
      return;
    }

    // Data frame: forward to the other peer
    const session = this._sessions.get(sessionId);
    if (!session) return;
    const [ep0, ep1] = session;
    const isFrom0 = ep0 && ep0.address === rinfo.address && ep0.port === rinfo.port;
    const dest = isFrom0 ? ep1 : ep0;
    if (!dest) return;
    this._socket.send(msg, dest.port, dest.address);
  }

  _joinSession(sessionId, rinfo) {
    const s = this._sessions.get(sessionId) || [null, null];
    const alreadyIn = (s[0] && s[0].address === rinfo.address && s[0].port === rinfo.port) ||
                      (s[1] && s[1].address === rinfo.address && s[1].port === rinfo.port);
    if (alreadyIn) return;
    if (!s[0]) {
      this._sessions.set(sessionId, [rinfo, s[1]]);
    } else {
      this._sessions.set(sessionId, [s[0], rinfo]);
      this.emit('session-linked', { sessionId, endpoints: [s[0], rinfo] });
    }
  }

  close() {
    if (this._socket) { try { this._socket.close(); } catch {} this._socket = null; }
  }
}

// ── RelayStream ───────────────────────────────────────────────
// A Node.js Duplex stream that tunnels data through the relay UDP server.
// Drop-in replacement for net.Socket in sendFile/sendMessage etc.
class RelayStream extends stream.Duplex {
  constructor({ relayIp, relayPort, token, sessionId, localPort }) {
    super();
    this._relayIp   = relayIp;
    this._relayPort = relayPort;
    this._token     = token;
    this._sessionId = sessionId; // hex string, 24 chars
    this._localPort = localPort;
    this._socket    = null;
    this._authed    = false;
    // Compat with net.Socket callers
    this.setNoDelay   = () => {};
    this.setTimeout   = () => {};
    this.remoteAddress = relayIp;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this._socket = sock;

      const timer = setTimeout(() => { reject(new Error('Relay auth timeout')); sock.close(); }, 6000);

      sock.on('message', (msg, rinfo) => {
        if (!this._authed) {
          // ACK is exactly RELAY_HDR_LEN bytes, no payload
          if (msg.length === RELAY_HDR_LEN &&
              msg.slice(0, RELAY_MAGIC.length).equals(RELAY_MAGIC)) {
            clearTimeout(timer);
            this._authed = true;
            resolve();
          }
          return;
        }
        // Data frames
        if (msg.length <= RELAY_HDR_LEN) return;
        if (!msg.slice(0, RELAY_MAGIC.length).equals(RELAY_MAGIC)) return;
        const payload = msg.slice(RELAY_HDR_LEN);
        this.push(payload);
      });

      sock.on('error', (err) => this.destroy(err));

      sock.bind(this._localPort, () => {
        const tokenBuf   = Buffer.from(this._token, 'ascii');
        const sessionBuf = Buffer.from(this._sessionId, 'hex');
        const frame      = Buffer.concat([
          RELAY_MAGIC, sessionBuf,
          Buffer.from([0x01, tokenBuf.length]),
          tokenBuf,
        ]);
        sock.send(frame, this._relayPort, this._relayIp);
      });
    });
  }

  _write(chunk, _enc, cb) {
    if (!this._socket || !this._authed) { cb(new Error('Relay not connected')); return; }
    const sessionBuf = Buffer.from(this._sessionId, 'hex');
    const frame = Buffer.concat([RELAY_MAGIC, sessionBuf, chunk]);
    this._socket.send(frame, this._relayPort, this._relayIp, cb);
  }

  _read() { /* data arrives via UDP message events, pushed in _socket.on('message') */ }

  end(data, enc, cb) {
    if (data) this.write(data, enc);
    this.push(null);
    if (typeof enc === 'function') enc();
    if (typeof cb  === 'function') cb();
    return this;
  }

  destroy(err) {
    if (this._socket) { try { this._socket.close(); } catch {} this._socket = null; }
    super.destroy(err);
    return this;
  }
}

// ── HolePuncher ───────────────────────────────────────────────
class HolePuncher {
  constructor({ localPort, remoteIp, remotePort }) {
    this._localPort  = localPort;
    this._remoteIp   = remoteIp;
    this._remotePort = remotePort;
    this._socket     = null;
    this._done       = false;
  }

  attempt() {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this._socket = sock;

      sock.on('error', () => { if (!this._done) this._end(false, resolve); });
      sock.on('message', (msg) => {
        if (!this._done && msg.length >= PUNCH_MAGIC.length &&
            msg.slice(0, PUNCH_MAGIC.length).equals(PUNCH_MAGIC)) {
          clearInterval(this._timer);
          clearTimeout(this._timeout);
          this._done = true;
          resolve({ success: true, socket: sock });
        }
      });

      sock.bind(this._localPort, () => {
        this._timer   = setInterval(() => sock.send(PUNCH_MAGIC, this._remotePort, this._remoteIp), PUNCH_INTERVAL_MS);
        this._timeout = setTimeout(() => this._end(false, resolve), PUNCH_TIMEOUT_MS);
      });
    });
  }

  _end(success, resolve) {
    if (this._done) return;
    this._done = true;
    clearInterval(this._timer);
    clearTimeout(this._timeout);
    if (!success && this._socket) { try { this._socket.close(); } catch {} }
    resolve({ success, socket: null });
  }

  cancel() {
    this._done = true;
    clearInterval(this._timer);
    clearTimeout(this._timeout);
    if (this._socket) { try { this._socket.close(); } catch {} }
  }
}

// ── WanNegotiator ─────────────────────────────────────────────
// Coordinates hole-punch over an existing TCP socket.
// The TCP socket's data listener is temporarily hijacked for the
// one-line JSON exchange, then fully restored for transfer use.
class WanNegotiator {
  constructor(tcpSocket, opts) {
    this._tcp  = tcpSocket;
    this._opts = opts;
  }

  async negotiate() {
    const {
      isInitiator,
      localUdpPort,
      token,           // only provided by the non-relay side
      relayIp,         // only provided by the relay host (responder)
      relayPort,
      registerSession, // fn(sessionId) — called by responder to register in RelayServer
    } = this._opts;

    let remoteOffer;
    let sessionId;

    try {
      if (isInitiator) {
        // Send offer first, then read reply
        const offer = JSON.stringify({ type: 'punch-offer', udpPort: localUdpPort, token: token || null }) + '\n';
        this._tcp.write(offer);
        const line = await this._readLine(4000);
        if (!line) return { method: 'tcp' };
        remoteOffer = JSON.parse(line);
        sessionId   = remoteOffer.sessionId || null;
      } else {
        // Responder: read offer, then send reply
        const line = await this._readLine(4000);
        if (!line) return { method: 'tcp' };
        remoteOffer = JSON.parse(line);
        sessionId   = generateSessionId();
        if (registerSession) registerSession(sessionId);
        const reply = JSON.stringify({
          type:      'punch-reply',
          udpPort:   localUdpPort,
          sessionId,
          hasRelay:  !!(relayIp && relayPort),
          relayIp:   relayIp   || null,
          relayPort: relayPort || null,
        }) + '\n';
        this._tcp.write(reply);
      }
    } catch (e) {
      console.warn('[punch] Negotiation error:', e.message);
      return { method: 'tcp' };
    }

    const remoteUdpPort = remoteOffer.udpPort;
    const remoteIp      = this._tcp.remoteAddress?.replace(/^::ffff:/, ''); // strip IPv6-mapped prefix

    if (!remoteUdpPort || !remoteIp) return { method: 'tcp' };

    // ── Punch attempt ──────────────────────────────────────────
    const puncher = new HolePuncher({
      localPort:  localUdpPort,
      remoteIp,
      remotePort: remoteUdpPort,
    });

    console.log(`[punch] Attempting UDP ${localUdpPort} → ${remoteIp}:${remoteUdpPort}`);
    const result = await puncher.attempt();

    if (result.success) {
      console.log(`[punch] ✓ Direct UDP to ${remoteIp}:${remoteUdpPort}`);
      return { method: 'direct', socket: result.socket, remoteIp, remotePort: remoteUdpPort };
    }

    console.log(`[punch] Direct failed`);

    // ── Relay fallback ─────────────────────────────────────────
    // Only the initiator (non-relay side) connects to the relay.
    // The responder (relay host) is the relay server itself — it just waits.
    const canUseRelay = isInitiator &&
      remoteOffer.hasRelay &&
      remoteOffer.relayIp  &&
      remoteOffer.relayPort &&
      sessionId &&
      (token || remoteOffer.token);

    if (canUseRelay) {
      const usedToken = token || remoteOffer.token;
      console.log(`[punch] Trying relay ${remoteOffer.relayIp}:${remoteOffer.relayPort} session=${sessionId}`);
      const rs = new RelayStream({
        relayIp:   remoteOffer.relayIp,
        relayPort: remoteOffer.relayPort,
        token:     usedToken,
        sessionId,
        localPort: localUdpPort + 10, // avoid conflict with punch socket
      });
      try {
        await rs.connect();
        console.log(`[punch] ✓ Relay connected`);
        return { method: 'relay', stream: rs };
      } catch (e) {
        console.warn('[punch] Relay failed:', e.message);
      }
    }

    return { method: 'tcp' };
  }

  // Read a single newline-terminated line from the TCP socket,
  // without consuming any bytes beyond the newline.
  _readLine(timeoutMs) {
    return new Promise((resolve) => {
      let buf = '';
      let done = false;

      const timer = setTimeout(() => { done = true; cleanup(); resolve(null); }, timeoutMs);

      const onData = (chunk) => {
        if (done) return;
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          done = true;
          // Put anything after the newline back by unshifting into the socket
          const rest = buf.slice(nl + 1);
          cleanup();
          if (rest.length > 0) {
            // Re-emit leftover bytes as a synthetic data event on next tick
            setImmediate(() => this._tcp.emit('data', Buffer.from(rest)));
          }
          resolve(buf.slice(0, nl).trim());
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this._tcp.removeListener('data', onData);
      };

      this._tcp.on('data', onData);
    });
  }
}

module.exports = {
  generateToken,
  generateSessionId,
  RelayServer,
  RelayStream,
  HolePuncher,
  WanNegotiator,
  RELAY_PORT_OFFSET,
  PUNCH_UDP_OFFSET,
};
