/**
 * upnp-client.js — UPnP/NAT-PMP port mapping, no external dependencies.
 * Uses dgram (SSDP discovery) + http (SOAP control).
 * Node.js built-ins only.
 */

'use strict';

const dgram  = require('dgram');
const http   = require('http');
const os     = require('os');
const { URL } = require('url');

// ── SSDP Discovery ─────────────────────────────────────────────
const SSDP_ADDR    = '239.255.255.250';
const SSDP_PORT    = 1900;
const SSDP_SEARCH  =
  'M-SEARCH * HTTP/1.1\r\n' +
  'HOST: 239.255.255.250:1900\r\n' +
  'MAN: "ssdp:discover"\r\n' +
  'MX: 3\r\n' +
  'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n';

function discoverGateway(timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = (val, err) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      err ? reject(err) : resolve(val);
    };

    const timer = setTimeout(() => finish(null, new Error('UPnP gateway not found (timeout)')), timeoutMs);

    sock.on('message', (msg) => {
      const str = msg.toString();
      // Extract LOCATION header
      const m = str.match(/LOCATION:\s*(.+)/i);
      if (m) finish(m[1].trim());
    });

    sock.on('error', (err) => finish(null, err));

    sock.bind(0, () => {
      sock.setBroadcast(true);
      const buf = Buffer.from(SSDP_SEARCH);
      sock.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR, (err) => {
        if (err) finish(null, err);
      });
    });
  });
}

// ── Fetch and parse device description XML ────────────────────
function fetchXml(locationUrl) {
  return new Promise((resolve, reject) => {
    const req = http.get(locationUrl, { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('XML fetch timeout')); });
  });
}

// Extract control URL for WANIPConnection or WANPPPConnection service
function parseControlUrl(xml, locationUrl) {
  // Look for WANIPConnection or WANPPPConnection service
  const serviceTypes = [
    'WANIPConnection:1',
    'WANPPPConnection:1',
    'WANIPConnection:2',
  ];
  for (const st of serviceTypes) {
    // Find the <service> block containing this serviceType
    const stIdx = xml.indexOf(st);
    if (stIdx === -1) continue;
    // Find controlURL within the surrounding <service> block
    const blockStart = xml.lastIndexOf('<service>', stIdx);
    const blockEnd   = xml.indexOf('</service>', stIdx);
    if (blockStart === -1 || blockEnd === -1) continue;
    const block = xml.slice(blockStart, blockEnd);
    const cu = block.match(/<controlURL>([^<]+)<\/controlURL>/i);
    if (!cu) continue;
    // Resolve relative URL against location
    const base = new URL(locationUrl);
    const path = cu[1].trim();
    return path.startsWith('http') ? path : `${base.protocol}//${base.host}${path.startsWith('/') ? '' : '/'}${path}`;
  }
  throw new Error('No WANIPConnection service found in device description');
}

// ── SOAP action ───────────────────────────────────────────────
function soapAction(controlUrl, action, serviceType, args = {}) {
  const argsXml = Object.entries(args)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');
  const body =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<u:${action} xmlns:u="${serviceType}">` +
    argsXml +
    `</u:${action}>` +
    '</s:Body></s:Envelope>';

  return new Promise((resolve, reject) => {
    const u   = new URL(controlUrl);
    const opt = {
      hostname: u.hostname,
      port:     parseInt(u.port) || 80,
      path:     u.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'text/xml; charset="utf-8"',
        'SOAPAction':     `"${serviceType}#${action}"`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(opt, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`SOAP error ${res.statusCode}: ${data.slice(0, 200)}`));
        else resolve(data);
      });
    });
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('SOAP timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

// ── UPnP Client ───────────────────────────────────────────────
class UPnPClient {
  constructor() {
    this._controlUrl   = null;
    this._serviceType  = null;
    this._locationUrl  = null;
    this._ready        = false;
    this._mappings     = []; // { port, protocol } — for cleanup on exit
  }

  // Discover gateway and cache control URL
  async init(timeoutMs = 5000) {
    const location = await discoverGateway(timeoutMs);
    this._locationUrl = location;
    const xml = await fetchXml(location);

    // Determine which service type was found
    if      (xml.includes('WANIPConnection:2'))  this._serviceType = 'urn:schemas-upnp-org:service:WANIPConnection:2';
    else if (xml.includes('WANIPConnection:1'))  this._serviceType = 'urn:schemas-upnp-org:service:WANIPConnection:1';
    else if (xml.includes('WANPPPConnection:1')) this._serviceType = 'urn:schemas-upnp-org:service:WANPPPConnection:1';
    else throw new Error('No compatible UPnP service found');

    this._controlUrl = parseControlUrl(xml, location);
    this._ready = true;
    return true;
  }

  // Add a TCP port mapping. Returns { externalPort, internalPort, localIp }
  async addPortMapping(internalPort, externalPort = null, description = 'EdgeShare', leaseDuration = 3600) {
    if (!this._ready) await this.init();
    const localIp = getLocalIp();
    const extPort = externalPort || internalPort;

    await soapAction(this._controlUrl, 'AddPortMapping', this._serviceType, {
      NewRemoteHost:             '',
      NewExternalPort:           extPort,
      NewProtocol:               'TCP',
      NewInternalPort:           internalPort,
      NewInternalClient:         localIp,
      NewEnabled:                1,
      NewPortMappingDescription: description,
      NewLeaseDuration:          leaseDuration,
    });

    this._mappings.push({ port: extPort, protocol: 'TCP' });
    return { externalPort: extPort, internalPort, localIp };
  }

  // Try addPortMapping, fall back to a random port if the requested one is taken
  async addPortMappingWithFallback(preferredPort, description = 'EdgeShare') {
    if (!this._ready) await this.init();
    // Try up to 5 ports starting from preferred
    for (let i = 0; i < 5; i++) {
      const port = preferredPort + i;
      try {
        return await this.addPortMapping(port, port, description);
      } catch (err) {
        // ConflictInMappingEntry (718) means port is taken — try next
        if (!err.message.includes('718') && !err.message.includes('ConflictInMappingEntry')) throw err;
      }
    }
    throw new Error('Could not find a free UPnP port');
  }

  async removePortMapping(externalPort) {
    if (!this._ready || !this._controlUrl) return;
    try {
      await soapAction(this._controlUrl, 'DeletePortMapping', this._serviceType, {
        NewRemoteHost:    '',
        NewExternalPort:  externalPort,
        NewProtocol:      'TCP',
      });
    } catch {} // best-effort
    this._mappings = this._mappings.filter(m => m.port !== externalPort);
  }

  async getExternalIP() {
    if (!this._ready) await this.init();
    const xml = await soapAction(this._controlUrl, 'GetExternalIPAddress', this._serviceType);
    const m = xml.match(/<NewExternalIPAddress>([^<]+)<\/NewExternalIPAddress>/i);
    return m ? m[1].trim() : null;
  }

  // Remove all mappings we created — call on app exit
  async cleanup() {
    for (const { port } of this._mappings) {
      await this.removePortMapping(port).catch(() => {});
    }
    this._mappings = [];
  }
}

module.exports = { UPnPClient, getLocalIp };
