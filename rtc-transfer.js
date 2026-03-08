/**
 * rtc-transfer.js — WebRTC DataChannel file transfer
 * Pure browser JS (no Node/Buffer). Renderer process only.
 *
 * Code format:  E1~<b62(JSON)>
 * JSON: { u, p, f, c }  (ufrag, pwd, fingerprint-hex-no-colons, candidates["ip:port"])
 * Typical code length: ~130-160 chars
 */

// ── Base62 ────────────────────────────────────────────────────
const _B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function b62Enc(u8) {
  if (!u8.length) return '0';
  let n = 0n;
  for (const b of u8) n = (n << 8n) | BigInt(b);
  if (n === 0n) return '0';
  let s = '';
  while (n > 0n) { s = _B62[Number(n % 62n)] + s; n /= 62n; }
  return s;
}

function b62Dec(s) {
  let n = 0n;
  for (const c of s) {
    const i = _B62.indexOf(c);
    if (i < 0) throw new Error('Invalid character in transfer code: ' + JSON.stringify(c));
    n = n * 62n + BigInt(i);
  }
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i*2, i*2+2), 16);
  return out;
}

// ── Code encode / decode ──────────────────────────────────────
function encodeCode(ufrag, pwd, fpWithColons, candidates) {
  const fpHex = fpWithColons.replace(/:/g, '').toUpperCase();
  const srflx = candidates.filter(c => c.type === 'srflx');
  const host  = candidates.filter(c => c.type === 'host' && !c.address.includes(':'));
  const picked = [...srflx, ...host].slice(0, 2).map(c => c.address + ':' + c.port);
  const bytes = new TextEncoder().encode(JSON.stringify({ u: ufrag, p: pwd, f: fpHex, c: picked }));
  return 'E1~' + b62Enc(bytes);
}

function decodeCode(raw) {
  const s = raw.trim();
  if (!s.startsWith('E1~')) throw new Error('Not an Edge transfer code (should start with E1~)');
  const { u, p, f, c } = JSON.parse(new TextDecoder().decode(b62Dec(s.slice(3))));
  const fp = f.toUpperCase().match(/.{2}/g).join(':');
  const candidates = (c || []).map(addr => {
    const i = addr.lastIndexOf(':');
    return { address: addr.slice(0, i), port: parseInt(addr.slice(i + 1)) };
  });
  return { ufrag: u, pwd: p, fp, candidates };
}

// ── SDP helpers ───────────────────────────────────────────────
// Wait for ICE gathering to complete on an already-described PC.
// Must be called AFTER setLocalDescription.
function waitForICE(pc, ms = 5000) {
  return new Promise(resolve => {
    console.log('[RTC] waitForICE start, state:', pc.iceGatheringState);
    if (pc.iceGatheringState === 'complete') { console.log('[RTC] already complete'); resolve(); return; }
    const done = () => { console.log('[RTC] ICE gather done, state:', pc.iceGatheringState); resolve(); };
    const timer = setTimeout(() => { console.log('[RTC] ICE gather TIMEOUT after', ms, 'ms, state:', pc.iceGatheringState); done(); }, ms);
    pc.onicegatheringstatechange = () => {
      console.log('[RTC] iceGatheringState ->', pc.iceGatheringState);
      if (pc.iceGatheringState === 'complete') { clearTimeout(timer); done(); }
    };
  });
}

function extractCredentials(sdp) {
  const ufrag = sdp.match(/a=ice-ufrag:(\S+)/)?.[1];
  const pwd   = sdp.match(/a=ice-pwd:(\S+)/)?.[1];
  const fp    = sdp.match(/a=fingerprint:sha-256 (\S+)/i)?.[1];
  return { ufrag, pwd, fp };
}

// Parse all candidates from a final (gathered) SDP
function parseSdpCandidates(sdp) {
  const out = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue;
    const m = line.match(/a=candidate:\S+ \d+ \S+ \d+ (\S+) (\d+) typ (\S+)/);
    if (m) out.push({ address: m[1], port: parseInt(m[2]), type: m[3] });
  }
  return out;
}

// A valid minimal offer SDP Chrome will accept (has BUNDLE, extmap-allow-mixed, etc.)
function makeOfferSDP(ufrag, pwd, fp) {
  return [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:' + ufrag,
    'a=ice-pwd:' + pwd,
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 ' + fp,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ].join('\r\n') + '\r\n';
}

// Add remote ICE candidates (called after BOTH descriptions are set)
async function addRemoteCandidates(pc, candidates) {
  for (const c of candidates) {
    try {
      const priv = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)/.test(c.address);
      const type = priv ? 'host' : 'srflx';
      const line = `candidate:0 1 UDP 1 ${c.address} ${c.port} typ ${type}` +
        (type === 'srflx' ? ' raddr 0.0.0.0 rport 0' : '');
      await pc.addIceCandidate(new RTCIceCandidate({ candidate: line, sdpMid: '0', sdpMLineIndex: 0 }));
    } catch (_) {}
  }
}

// ── Constants ─────────────────────────────────────────────────
const CHUNK    = 65536;
const BUF_HIGH = 2 * 1024 * 1024;
const STUN = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302'  },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]};

// ── RTCTransfer ───────────────────────────────────────────────
class RTCTransfer {
  constructor() {
    this._pc = null; this._dc = null;
    this._fileMeta = null; this._handlers = {};
  }
  on(e, fn) { this._handlers[e] = fn; return this; }
  _emit(e, ...a) { this._handlers[e]?.(...a); }

  // ── SENDER step 1 ─────────────────────────────────────────
  async initSend(fileMeta) {
    this._fileMeta = fileMeta;
    const pc = this._makePC();

    // DataChannel must exist before createOffer
    const dc = pc.createDataChannel('f', { ordered: true });
    this._dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen  = () => this._runSend();
    dc.onclose = () => this._emit('disconnected');
    dc.onerror = e => this._emit('error', new Error(String(e.error ?? 'channel error')));

    // 1. Create offer + set local description
    console.log("[RTC] sender: createOffer...");
    await pc.setLocalDescription(await pc.createOffer());
    console.log("[RTC] sender: localDesc set, iceGatheringState:", pc.iceGatheringState);

    // 2. Wait for ICE gathering (happens automatically after setLocalDescription)
    await waitForICE(pc);
    console.log("[RTC] sender: ICE gathered");

    // 3. Extract everything from the final gathered SDP
    const sdp = pc.localDescription.sdp;
    const { ufrag, pwd, fp } = extractCredentials(sdp);
    if (!ufrag || !pwd || !fp) throw new Error('Could not read ICE credentials');
    const candidates = parseSdpCandidates(sdp);
    return encodeCode(ufrag, pwd, fp, candidates);
  }

  // ── SENDER step 2 ─────────────────────────────────────────
  async acceptAnswer(answerCode) {
    const { ufrag, pwd, fp, candidates } = decodeCode(answerCode);
    const pc = this._pc;

    // Patch our local SDP into a valid answer by swapping remote credentials
    const remoteSDP = pc.localDescription.sdp
      .replace(/a=ice-ufrag:\S+/g, 'a=ice-ufrag:' + ufrag)
      .replace(/a=ice-pwd:\S+/g,   'a=ice-pwd:'   + pwd)
      .replace(/a=fingerprint:sha-256 \S+/gi, 'a=fingerprint:sha-256 ' + fp)
      .replace(/a=setup:\S+/g, 'a=setup:active');

    await pc.setRemoteDescription({ type: 'answer', sdp: remoteSDP });
    await addRemoteCandidates(pc, candidates);
  }

  // ── RECEIVER step 1 ───────────────────────────────────────
  async initReceive(offerCode) {
    console.log("[RTC] initReceive, code length:", offerCode?.length);
    let decoded;
    try { decoded = decodeCode(offerCode); } catch(e) { console.error("[RTC] decodeCode failed:", e); throw e; }
    const { ufrag, pwd, fp, candidates } = decoded;
    console.log("[RTC] decoded: ufrag=" + ufrag + " candidates=" + candidates.length);
    const pc = this._makePC();

    pc.ondatachannel = e => {
      this._dc = e.channel;
      this._dc.binaryType = 'arraybuffer';
      this._setupRecv();
    };

    // 1. Build synthetic offer SDP and set as remote description
    const offerSDP = makeOfferSDP(ufrag, pwd, fp);
    console.log("[RTC] receiver: setRemoteDescription...");
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSDP });
    console.log("[RTC] receiver: remoteDesc set");

    // 2. Create answer + set local description
    console.log("[RTC] receiver: createAnswer...");
    await pc.setLocalDescription(await pc.createAnswer());
    console.log("[RTC] receiver: localDesc set, iceGatheringState:", pc.iceGatheringState);

    // 3. NOW add remote candidates (both descriptions are set)
    await addRemoteCandidates(pc, candidates);
    console.log("[RTC] receiver: remote candidates added");

    // 4. Wait for our own ICE gathering to complete
    await waitForICE(pc);
    console.log("[RTC] receiver: ICE gathered");

    // 5. Extract our answer credentials + candidates from final SDP
    const sdp = pc.localDescription.sdp;
    const { ufrag: au, pwd: ap, fp: af } = extractCredentials(sdp);
    if (!au || !ap || !af) throw new Error('Could not read answer credentials');
    const answerCandidates = parseSdpCandidates(sdp);
    return encodeCode(au, ap, af, answerCandidates);
  }

  // ── Receive ────────────────────────────────────────────────
  _setupRecv() {
    let meta = null, received = 0;
    this._dc.onmessage = async e => {
      if (typeof e.data === 'string') { meta = JSON.parse(e.data); this._emit('receiveStart', meta); return; }
      if (!meta) return;
      const chunk = new Uint8Array(e.data);
      received += chunk.byteLength;
      await window.electronAPI.rtcWriteChunk(meta.name, chunk.buffer);
      this._emit('progress', { received, total: meta.size, pct: meta.size ? received / meta.size * 100 : 0 });
      if (received >= meta.size) {
        await window.electronAPI.rtcFileComplete(meta.name);
        this._emit('done', { name: meta.name, size: meta.size });
        this.close();
      }
    };
    this._dc.onerror = e => this._emit('error', new Error(String(e.error ?? 'recv error')));
  }

  // ── Send ───────────────────────────────────────────────────
  async _runSend() {
    const { path: fp, name, size } = this._fileMeta;
    const dc = this._dc;
    this._emit('sendStart', { name, size });
    dc.send(JSON.stringify({ name, size }));
    let offset = 0;
    while (offset < size) {
      while (dc.bufferedAmount > BUF_HIGH) {
        await new Promise(r => setTimeout(r, 20));
        if (dc.readyState !== 'open') return;
      }
      if (dc.readyState !== 'open') break;
      const len = Math.min(CHUNK, size - offset);
      const chunk = await window.electronAPI.rtcReadChunk(fp, offset, len);
      dc.send(chunk);
      offset += len;
      this._emit('progress', { sent: offset, total: size, pct: size ? offset / size * 100 : 0 });
    }
  }

  _makePC() {
    try { this._pc?.close(); } catch {}
    this._pc = new RTCPeerConnection(STUN);
    this._pc.onconnectionstatechange = () => {
      const s = this._pc?.connectionState;
      if (s === 'connected') this._emit('connected');
      if (s === 'disconnected' || s === 'failed') this._emit('disconnected');
    };
    return this._pc;
  }

  close() {
    try { this._dc?.close(); } catch {}
    try { this._pc?.close(); } catch {}
    this._pc = this._dc = null;
  }
}
