// WebRTC peer-to-peer file transfer
// Runs in the RENDERER process (has access to RTCPeerConnection via Chromium)
// Main process only does file I/O via IPC

const STUN = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]};

const CHUNK = 65536; // 64 KB chunks over DataChannel
const B62   = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// ── Compact code encode/decode ────────────────────────────────
// Format: E1~ufrag~pwd~fingerprint_hex~candidate1[~candidate2]
// Base62-encoded for URL/paste safety, ~120-140 chars typical

function b62enc(buf) {
  // buf is Uint8Array or Buffer
  let n = BigInt('0x' + Buffer.from(buf).toString('hex') || '0');
  if (n === 0n) return '0';
  let s = '';
  while (n > 0n) { s = B62[Number(n % 62n)] + s; n /= 62n; }
  return s;
}

function b62dec(s) {
  let n = 0n;
  for (const c of s) {
    const i = B62.indexOf(c);
    if (i < 0) throw new Error('Bad char: ' + c);
    n = n * 62n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

function encodeOffer(ufrag, pwd, fp, candidates) {
  // fp is "sha-256 AA:BB:CC:..." — strip colons and sha-256 prefix, store raw 32 bytes
  const fpHex = fp.replace(/^[a-z0-9-]+ /i, '').replace(/:/g, '');
  const fpB62 = b62enc(Buffer.from(fpHex, 'hex'));
  // candidates: prefer srflx (public) then host (local), take up to 2
  const cands = candidates
    .filter(c => c.type === 'srflx' || c.type === 'host')
    .sort((a, b) => (a.type === 'srflx' ? -1 : 1)) // srflx first
    .slice(0, 2)
    .map(c => `${c.address}:${c.port}`);
  const parts = ['E1', ufrag, pwd, fpB62, ...cands];
  return parts.join('~');
}

function decodeOffer(code) {
  if (!code.startsWith('E1~')) throw new Error('Not an Edge transfer code');
  const [, ufrag, pwd, fpB62, ...cands] = code.split('~');
  const fpHex = b62dec(fpB62).toString('hex').toUpperCase();
  // Reformat with colons: AABBCC → AA:BB:CC
  const fp = 'sha-256 ' + fpHex.match(/.{2}/g).join(':');
  const candidates = cands.map(c => {
    const lastColon = c.lastIndexOf(':');
    return { address: c.slice(0, lastColon), port: parseInt(c.slice(lastColon + 1)) };
  });
  return { ufrag, pwd, fp, candidates };
}

// ── ICE candidate gathering ───────────────────────────────────
function gatherCandidates(pc, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const candidates = [];
    const done = () => resolve(candidates);
    const timer = setTimeout(done, timeoutMs);
    pc.onicecandidate = (e) => {
      if (!e.candidate) { clearTimeout(timer); done(); return; }
      const c = e.candidate;
      // Parse candidate string: "candidate:X Y UDP/TCP prio ip port typ type ..."
      const m = c.candidate.match(/(\S+) \d+ \S+ \d+ (\S+) (\d+) typ (\S+)/);
      if (m) candidates.push({ foundation: m[1], address: m[2], port: parseInt(m[3]), type: m[4] });
    };
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); done(); } };
  });
}

// Build a minimal SDP answer/offer from our compact code fields
// This is used on the receiver side to reconstruct a valid SDP
function buildRemoteSDP(role, ufrag, pwd, fp, candidates, ourSDP) {
  // Take our local SDP as base, replace ICE credentials and fingerprint,
  // add remote candidates as fake SDP lines so Chrome accepts it
  let sdp = ourSDP;
  // The remote SDP we construct doesn't need to be full — we use setRemoteDescription
  // with a synthesised SDP, then addIceCandidate for each candidate separately
  const lines = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:${fp}`,
    `a=setup:${role === 'offer' ? 'active' : 'passive'}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];
  return lines.join('\r\n') + '\r\n';
}

// ── Main WebRTCManager class ──────────────────────────────────
class WebRTCManager {
  constructor(ipc) {
    this.ipc = ipc; // window.electronAPI
    this._pc = null;
    this._dc = null;
    this._sendFile = null;
    this._recvMeta = null;
    this._recvBytes = 0;
    this._onProgress = null;
    this._onComplete = null;
    this._onError = null;
    this._onCodeReady = null; // called with compact code string
    this._onNeedAnswer = null; // called when offer received, need answer
  }

  on(event, fn) { this['_on' + event[0].toUpperCase() + event.slice(1)] = fn; return this; }

  _emit(event, ...args) {
    const fn = this['_on' + event[0].toUpperCase() + event.slice(1)];
    if (fn) fn(...args);
  }

  _createPC() {
    if (this._pc) { try { this._pc.close(); } catch {} }
    this._pc = new RTCPeerConnection(STUN);
    this._pc.onconnectionstatechange = () => {
      const s = this._pc.connectionState;
      if (s === 'failed' || s === 'disconnected') this._emit('error', new Error('Connection ' + s));
    };
    return this._pc;
  }

  // ── SENDER ────────────────────────────────────────────────
  async startSend(filePath, fileName, fileSize) {
    this._sendFile = { filePath, fileName, fileSize };
    const pc = this._createPC();

    // Create DataChannel before offer so it's in the SDP
    const dc = pc.createDataChannel('file', { ordered: true });
    this._dc = dc;
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => this._doSend();
    dc.onerror = (e) => this._emit('error', e.error || new Error('DataChannel error'));

    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Gather ICE candidates (wait for complete or timeout)
    const candidates = await gatherCandidates(pc);

    // Extract credentials from local SDP
    const sdp = pc.localDescription.sdp;
    const ufrag = sdp.match(/a=ice-ufrag:(\S+)/)?.[1];
    const pwd   = sdp.match(/a=ice-pwd:(\S+)/)?.[1];
    const fp    = sdp.match(/a=fingerprint:(.+)/)?.[1]?.trim();

    if (!ufrag || !pwd || !fp) throw new Error('Could not extract ICE credentials from SDP');

    const code = encodeOffer(ufrag, pwd, fp, candidates);
    this._emit('codeReady', code, fileName, fileSize);
    return code;
  }

  async receiveAnswer(answerCode) {
    const { ufrag, pwd, fp, candidates } = decodeOffer(answerCode);
    const pc = this._pc;

    // Build minimal remote SDP
    const remoteSDP = buildRemoteSDP('answer', ufrag, pwd, fp, candidates, pc.localDescription.sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp: remoteSDP });

    // Add ICE candidates
    for (const c of candidates) {
      try {
        await pc.addIceCandidate({
          candidate: `candidate:0 1 UDP 1 ${c.address} ${c.port} typ ${candidates.indexOf(c) === 0 ? 'srflx' : 'host'} raddr 0.0.0.0 rport 0`,
          sdpMid: '0',
          sdpMLineIndex: 0,
        });
      } catch {}
    }
  }

  // ── RECEIVER ──────────────────────────────────────────────
  async startReceive(offerCode) {
    const { ufrag, pwd, fp, candidates } = decodeOffer(offerCode);
    const pc = this._createPC();

    pc.ondatachannel = (e) => {
      this._dc = e.channel;
      this._dc.binaryType = 'arraybuffer';
      this._setupReceiveChannel();
    };

    // Build minimal remote offer SDP
    const remoteSDP = buildRemoteSDP('offer', ufrag, pwd, fp, candidates, '');
    await pc.setRemoteDescription({ type: 'offer', sdp: remoteSDP });

    // Add ICE candidates
    for (const c of candidates) {
      try {
        await pc.addIceCandidate({
          candidate: `candidate:0 1 UDP 1 ${c.address} ${c.port} typ ${candidates.indexOf(c) === 0 ? 'srflx' : 'host'} raddr 0.0.0.0 rport 0`,
          sdpMid: '0', sdpMLineIndex: 0,
        });
      } catch {}
    }

    // Create answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    const answerCandidates = await gatherCandidates(pc);
    const sdp = pc.localDescription.sdp;
    const aUfrag = sdp.match(/a=ice-ufrag:(\S+)/)?.[1];
    const aPwd   = sdp.match(/a=ice-pwd:(\S+)/)?.[1];
    const aFp    = sdp.match(/a=fingerprint:(.+)/)?.[1]?.trim();

    const answerCode = encodeOffer(aUfrag, aPwd, aFp, answerCandidates);
    this._emit('codeReady', answerCode);
    return answerCode;
  }

  _setupReceiveChannel() {
    const dc = this._dc;
    let meta = null, writeBuffer = [], totalReceived = 0;

    dc.onmessage = async (e) => {
      if (!meta) {
        // First message is JSON metadata
        meta = JSON.parse(e.data);
        this._recvMeta = meta;
        this._emit('receiveStart', meta);
        return;
      }
      // Binary chunk
      const chunk = e.data; // ArrayBuffer
      totalReceived += chunk.byteLength;
      await this.ipc.rtcWriteChunk(meta.fileName, chunk);
      const progress = meta.fileSize > 0 ? (totalReceived / meta.fileSize * 100) : 0;
      this._emit('progress', { received: totalReceived, total: meta.fileSize, progress });
      if (totalReceived >= meta.fileSize) {
        await this.ipc.rtcFileComplete(meta.fileName);
        this._emit('complete', { fileName: meta.fileName, size: meta.fileSize });
        dc.close();
      }
    };
    dc.onerror = (e) => this._emit('error', e.error || new Error('Channel error'));
  }

  async _doSend() {
    const dc = this._dc;
    const { filePath, fileName, fileSize } = this._sendFile;

    // Send metadata first
    dc.send(JSON.stringify({ fileName, fileSize }));

    // Stream file in chunks via IPC
    let offset = 0;
    const BUFFER_THRESHOLD = 1024 * 1024; // pause if buffer > 1MB

    const waitDrain = () => new Promise(r => {
      if (dc.bufferedAmount < BUFFER_THRESHOLD) { r(); return; }
      const check = setInterval(() => { if (dc.bufferedAmount < BUFFER_THRESHOLD) { clearInterval(check); r(); } }, 50);
    });

    while (offset < fileSize) {
      await waitDrain();
      if (dc.readyState !== 'open') break;
      const chunkSize = Math.min(CHUNK, fileSize - offset);
      const chunk = await this.ipc.rtcReadChunk(filePath, offset, chunkSize);
      dc.send(chunk);
      offset += chunkSize;
      this._emit('progress', { sent: offset, total: fileSize, progress: (offset / fileSize * 100) });
    }
  }

  close() {
    try { this._dc?.close(); } catch {}
    try { this._pc?.close(); } catch {}
    this._pc = null; this._dc = null;
  }
}

// Export for renderer use
window.WebRTCManager = WebRTCManager;
