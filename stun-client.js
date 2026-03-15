/**
 * stun-client.js — minimal RFC 5389 STUN client, zero dependencies.
 *
 * Sends a Binding Request to a STUN server and parses the XOR-MAPPED-ADDRESS
 * or MAPPED-ADDRESS from the response.  Returns the public IP:port that the
 * NAT assigned to our UDP socket — exactly what we need for hole punching.
 */

'use strict';

const dgram  = require('dgram');
const crypto = require('crypto');

// Public STUN servers — tried in order, first success wins
const DEFAULT_STUN_SERVERS = [
  { host: 'stun.l.google.com',      port: 19302 },
  { host: 'stun1.l.google.com',     port: 19302 },
  { host: 'stun.cloudflare.com',    port: 3478  },
  { host: 'stun.stunprotocol.org',  port: 3478  },
];

const STUN_BINDING_REQUEST  = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;
const STUN_MAGIC_COOKIE     = 0x2112A442;
const ATTR_MAPPED_ADDRESS     = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

function buildBindingRequest() {
  const txId  = crypto.randomBytes(12); // 96-bit transaction ID
  const buf   = Buffer.alloc(20);
  buf.writeUInt16BE(STUN_BINDING_REQUEST, 0);  // type
  buf.writeUInt16BE(0, 2);                      // length (no attributes)
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);      // magic cookie
  txId.copy(buf, 8);                            // transaction ID
  return { buf, txId };
}

function parseResponse(msg, txId) {
  if (msg.length < 20) return null;
  const type   = msg.readUInt16BE(0);
  const magic  = msg.readUInt32BE(4);
  const respTx = msg.slice(8, 20);

  if (type !== STUN_BINDING_RESPONSE) return null;
  if (magic !== STUN_MAGIC_COOKIE)    return null;
  if (!respTx.equals(txId))           return null;

  const attrLen = msg.readUInt16BE(2);
  let offset = 20;
  let mapped = null;
  let xorMapped = null;

  while (offset + 4 <= 20 + attrLen) {
    const attrType = msg.readUInt16BE(offset);
    const attrSize = msg.readUInt16BE(offset + 2);
    const val      = msg.slice(offset + 4, offset + 4 + attrSize);
    offset += 4 + attrSize;
    if (attrSize % 4 !== 0) offset += 4 - (attrSize % 4); // padding

    if (attrType === ATTR_XOR_MAPPED_ADDRESS && val.length >= 8) {
      const family = val.readUInt8(1);
      if (family === 0x01) { // IPv4
        const port = val.readUInt16BE(2) ^ (STUN_MAGIC_COOKIE >>> 16);
        const ip   = [
          (val.readUInt8(4) ^ 0x21),
          (val.readUInt8(5) ^ 0x12),
          (val.readUInt8(6) ^ 0xA4),
          (val.readUInt8(7) ^ 0x42),
        ].join('.');
        xorMapped = { ip, port };
      }
    }

    if (attrType === ATTR_MAPPED_ADDRESS && val.length >= 8) {
      const family = val.readUInt8(1);
      if (family === 0x01) {
        const port = val.readUInt16BE(2);
        const ip   = `${val.readUInt8(4)}.${val.readUInt8(5)}.${val.readUInt8(6)}.${val.readUInt8(7)}`;
        mapped = { ip, port };
      }
    }
  }

  return xorMapped || mapped || null;
}

/**
 * Query a single STUN server.
 * @param {object} server   - { host, port }
 * @param {number} localPort - bind to this UDP port (0 = OS chooses)
 * @param {number} timeoutMs
 * @returns {Promise<{ip, port, localPort}>}
 */
function queryStun(server, localPort = 0, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const { buf: req, txId } = buildBindingRequest();
    let done = false;

    const finish = (val, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      err ? reject(err) : resolve(val);
    };

    const timer = setTimeout(
      () => finish(null, new Error(`STUN timeout: ${server.host}:${server.port}`)),
      timeoutMs
    );

    sock.on('error', (e) => finish(null, e));

    sock.on('message', (msg) => {
      const result = parseResponse(msg, txId);
      if (result) finish({ ...result, localPort: sock.address().port });
    });

    sock.bind(localPort, () => {
      sock.send(req, 0, req.length, server.port, server.host, (err) => {
        if (err) finish(null, err);
      });
    });
  });
}

/**
 * Get our public IP:port by querying STUN servers.
 *
 * Priority:
 *   1. Peer's self-hosted STUN server (peerStun = { host, port }) — fastest,
 *      no third-party dependency, already trusted since we're adding this peer.
 *   2. Public STUN servers — fallback when peer has no STUN or is offline.
 *
 * @param {number}  localPort  - local UDP port to bind (0 = OS picks)
 * @param {object}  [peerStun] - peer's self-hosted STUN: { host, port }
 * @param {object[]} [servers] - override public server list
 */
async function getPublicAddress(localPort = 0, peerStun = null, servers = DEFAULT_STUN_SERVERS) {
  // Try peer's STUN first — it's on the same path we'll be punching through
  if (peerStun?.host && peerStun?.port) {
    try {
      const result = await queryStun(peerStun, localPort, 2000);
      console.log(`[STUN] Public address via peer STUN ${peerStun.host}:${peerStun.port}: ${result.ip}:${result.port}`);
      return { ...result, viaPeerStun: true };
    } catch (e) {
      console.warn(`[STUN] Peer STUN ${peerStun.host}:${peerStun.port} failed: ${e.message} — trying public servers`);
    }
  }

  // Fall back to public STUN servers
  for (const server of servers) {
    try {
      const result = await queryStun(server, localPort, 3000);
      console.log(`[STUN] Public address via ${server.host}: ${result.ip}:${result.port} (local :${result.localPort})`);
      return result;
    } catch (e) {
      console.warn(`[STUN] ${server.host} failed: ${e.message}`);
    }
  }
  throw new Error('All STUN servers failed — no internet connectivity?');
}

module.exports = { getPublicAddress, queryStun, DEFAULT_STUN_SERVERS };
