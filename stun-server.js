/**
 * stun-server.js — minimal RFC 5389 STUN server, zero dependencies.
 *
 * Binds a UDP socket and responds to Binding Requests with the
 * sender's observed public IP:port (XOR-MAPPED-ADDRESS).
 *
 * This is intentionally tiny — we only need the one message type
 * that lets a NAT'd peer discover their public endpoint.
 */

'use strict';

const dgram  = require('dgram');
const { EventEmitter } = require('events');

const STUN_BINDING_REQUEST  = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;
const STUN_MAGIC_COOKIE     = 0x2112A442;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

class StunServer extends EventEmitter {
  constructor() {
    super();
    this._socket = null;
    this._port   = null;
  }

  get port() { return this._port; }

  async listen(port) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      sock.on('error', (err) => {
        this.emit('error', err);
      });

      sock.on('message', (msg, rinfo) => {
        this._handleMessage(msg, rinfo);
      });

      sock.bind(port, () => {
        this._socket = sock;
        this._port   = sock.address().port;
        console.log(`[STUN] Server listening on port ${this._port}`);
        resolve(this._port);
      });

      sock.once('error', reject);
    });
  }

  _handleMessage(msg, rinfo) {
    // Minimum STUN message is 20 bytes (header only)
    if (msg.length < 20) return;

    const msgType = msg.readUInt16BE(0);
    if (msgType !== STUN_BINDING_REQUEST) return;

    const magic = msg.readUInt32BE(4);
    if (magic !== STUN_MAGIC_COOKIE) return;

    // Transaction ID: bytes 8–19
    const txId = msg.slice(8, 20);

    // Build XOR-MAPPED-ADDRESS attribute
    // Family: 0x01 = IPv4
    // Port: XOR'd with upper 16 bits of magic cookie
    // IP: XOR'd with magic cookie
    const ipParts = rinfo.address.split('.').map(Number);
    const xorPort = rinfo.port ^ (STUN_MAGIC_COOKIE >>> 16);
    const xorIp   = [
      ipParts[0] ^ 0x21,
      ipParts[1] ^ 0x12,
      ipParts[2] ^ 0xA4,
      ipParts[3] ^ 0x42,
    ];

    // Attribute: type(2) + length(2) + reserved(1) + family(1) + port(2) + ip(4) = 12 bytes
    const attr = Buffer.alloc(12);
    attr.writeUInt16BE(ATTR_XOR_MAPPED_ADDRESS, 0);
    attr.writeUInt16BE(8, 2);          // value length = 8 bytes
    attr.writeUInt8(0x00, 4);          // reserved
    attr.writeUInt8(0x01, 5);          // family = IPv4
    attr.writeUInt16BE(xorPort, 6);
    attr.writeUInt8(xorIp[0], 8);
    attr.writeUInt8(xorIp[1], 9);
    attr.writeUInt8(xorIp[2], 10);
    attr.writeUInt8(xorIp[3], 11);

    // STUN response header: type(2) + length(2) + magic(4) + txId(12) = 20 bytes
    const header = Buffer.alloc(20);
    header.writeUInt16BE(STUN_BINDING_RESPONSE, 0);
    header.writeUInt16BE(attr.length, 2);
    header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
    txId.copy(header, 8);

    const response = Buffer.concat([header, attr]);
    this._socket.send(response, rinfo.port, rinfo.address, (err) => {
      if (err) console.warn('[STUN] Send error:', err.message);
    });

    this.emit('request', { ip: rinfo.address, port: rinfo.port });
  }

  close() {
    if (this._socket) {
      try { this._socket.close(); } catch {}
      this._socket = null;
    }
  }
}

module.exports = { StunServer };
