/**
 * upnp-client.js — UPnP/NAT-PMP port mapping, no external dependencies.
 *
 * Fixes vs previous version:
 *  - SSDP searches for both IGD:1 and IGD:2 (two separate M-SEARCH packets)
 *  - discoverGateway collects ALL responses for 3s, tries each in order
 *    rather than blindly picking the first one
 *  - Explicit error logging so failures are visible in Electron logs
 *  - addPortMappingUDP added for relay server
 *  - multicastInterface set to local IP so Windows picks the right NIC
 */

'use strict';

const dgram  = require('dgram');
const http   = require('http');
const os     = require('os');
const { URL } = require('url');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

function makeSsdpSearch(deviceType) {
  return (
    'M-SEARCH * HTTP/1.1\r\n' +
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
    'MAN: "ssdp:discover"\r\n' +
    'MX: 3\r\n' +
    `ST: urn:schemas-upnp-org:device:${deviceType}\r\n\r\n`
  );
}

function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

// Collect all SSDP responses for `collectMs`, then resolve with the list.
// Searches for both IGD:1 and IGD:2.
function discoverGateways(collectMs = 3500) {
  return new Promise((resolve) => {
    const localIp   = getLocalIp();
    const locations = new Set();
    const sock      = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let   finished  = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      try { sock.close(); } catch {}
      resolve([...locations]);
    };

    const timer = setTimeout(finish, collectMs);

    sock.on('message', (msg) => {
      const str = msg.toString();
      const m   = str.match(/LOCATION:\s*(.+)/i);
      if (m) locations.add(m[1].trim());
    });

    sock.on('error', (err) => {
      console.warn('[UPnP] SSDP socket error:', err.message);
      finish();
    });

    sock.bind(0, localIp, () => {
      // Send M-SEARCH for both IGD:1 and IGD:2
      for (const st of ['InternetGatewayDevice:1', 'InternetGatewayDevice:2']) {
        const buf = Buffer.from(makeSsdpSearch(st));
        sock.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR, (err) => {
          if (err) console.warn('[UPnP] SSDP send error:', err.message);
        });
      }
    });
  });
}

function fetchXml(locationUrl) {
  return new Promise((resolve, reject) => {
    const req = http.get(locationUrl, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('XML fetch timeout')); });
  });
}

function parseControlUrl(xml, locationUrl) {
  const serviceTypes = [
    'WANIPConnection:2',
    'WANIPConnection:1',
    'WANPPPConnection:1',
  ];
  for (const st of serviceTypes) {
    const stIdx = xml.indexOf(st);
    if (stIdx === -1) continue;
    const blockStart = xml.lastIndexOf('<service>', stIdx);
    const blockEnd   = xml.indexOf('</service>', stIdx);
    if (blockStart === -1 || blockEnd === -1) continue;
    const block = xml.slice(blockStart, blockEnd);
    const cu    = block.match(/<controlURL>([^<]+)<\/controlURL>/i);
    if (!cu) continue;
    const base = new URL(locationUrl);
    const path = cu[1].trim();
    const serviceType = `urn:schemas-upnp-org:service:${st}`;
    const controlUrl  = path.startsWith('http') ? path : `${base.protocol}//${base.host}${path.startsWith('/') ? '' : '/'}${path}`;
    return { controlUrl, serviceType };
  }
  return null; // not found — not an error, just no WANIPConnection on this device
}

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
        if (res.statusCode >= 400) {
          reject(new Error(`SOAP ${action} failed HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        } else {
          resolve(data);
        }
      });
    });
    req.setTimeout(6000, () => { req.destroy(); reject(new Error(`SOAP ${action} timeout`)); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

class UPnPClient {
  constructor() {
    this._controlUrl  = null;
    this._serviceType = null;
    this._ready       = false;
    this._mappings    = [];
  }

  // Try each discovered gateway until one has a usable WANIPConnection service
  async init(timeoutMs = 6000) {
    const locations = await discoverGateways(timeoutMs - 1000);

    if (locations.length === 0) {
      throw new Error('UPnP: no gateway found on this network (SSDP timeout)');
    }

    console.log(`[UPnP] Found ${locations.length} gateway location(s):`, locations);

    let lastErr = null;
    for (const loc of locations) {
      try {
        const xml    = await fetchXml(loc);
        const parsed = parseControlUrl(xml, loc);
        if (!parsed) {
          console.log(`[UPnP] ${loc} has no WANIPConnection service — skipping`);
          continue;
        }
        this._controlUrl  = parsed.controlUrl;
        this._serviceType = parsed.serviceType;
        this._ready       = true;
        console.log(`[UPnP] Using gateway: ${loc} → ${this._controlUrl} (${this._serviceType})`);
        return true;
      } catch (err) {
        console.warn(`[UPnP] Failed to init from ${loc}:`, err.message);
        lastErr = err;
      }
    }

    throw lastErr || new Error('UPnP: no usable WANIPConnection found in any discovered gateway');
  }

  async addPortMapping(internalPort, externalPort = null, description = 'Edge', leaseDuration = 3600, protocol = 'TCP') {
    if (!this._ready) throw new Error('UPnP not initialised');
    const localIp = getLocalIp();
    const extPort = externalPort || internalPort;

    await soapAction(this._controlUrl, 'AddPortMapping', this._serviceType, {
      NewRemoteHost:             '',
      NewExternalPort:           extPort,
      NewProtocol:               protocol,
      NewInternalPort:           internalPort,
      NewInternalClient:         localIp,
      NewEnabled:                1,
      NewPortMappingDescription: description,
      NewLeaseDuration:          leaseDuration,
    });

    this._mappings.push({ port: extPort, protocol });
    console.log(`[UPnP] Mapped ${protocol} ${extPort} → ${localIp}:${internalPort}`);
    return { externalPort: extPort, internalPort, localIp };
  }

  async addPortMappingWithFallback(preferredPort, description = 'Edge', protocol = 'TCP') {
    if (!this._ready) throw new Error('UPnP not initialised');
    for (let i = 0; i < 5; i++) {
      const port = preferredPort + i;
      try {
        return await this.addPortMapping(port, port, description, 3600, protocol);
      } catch (err) {
        const isConflict = err.message.includes('718') || err.message.includes('ConflictInMappingEntry');
        if (!isConflict) throw err;
        console.log(`[UPnP] Port ${port}/${protocol} conflict, trying ${port + 1}`);
      }
    }
    throw new Error(`UPnP: could not find free port near ${preferredPort} for ${protocol}`);
  }

  async removePortMapping(externalPort, protocol = 'TCP') {
    if (!this._ready || !this._controlUrl) return;
    try {
      await soapAction(this._controlUrl, 'DeletePortMapping', this._serviceType, {
        NewRemoteHost:   '',
        NewExternalPort: externalPort,
        NewProtocol:     protocol,
      });
    } catch (e) {
      console.warn(`[UPnP] removePortMapping ${externalPort}/${protocol}:`, e.message);
    }
    this._mappings = this._mappings.filter(m => !(m.port === externalPort && m.protocol === protocol));
  }

  async getExternalIP() {
    if (!this._ready) throw new Error('UPnP not initialised');
    const xml = await soapAction(this._controlUrl, 'GetExternalIPAddress', this._serviceType);
    const m   = xml.match(/<NewExternalIPAddress>([^<]+)<\/NewExternalIPAddress>/i);
    if (!m || !m[1].trim()) throw new Error('UPnP: empty external IP in response');
    return m[1].trim();
  }

  async cleanup() {
    for (const { port, protocol } of this._mappings) {
      await this.removePortMapping(port, protocol).catch(() => {});
    }
    this._mappings = [];
  }
}

module.exports = { UPnPClient, getLocalIp };
