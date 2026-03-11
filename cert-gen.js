/**
 * cert-gen.js — Pure-Node self-signed TLS certificate generator.
 * No external dependencies. Generates RSA-2048 + SHA-256 X.509 v3 certs.
 * Certs are cached to disk so they persist across restarts (TOFU model).
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ── Minimal ASN.1 / DER encoder ──────────────────────────────

function encodeLength(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...contents) {
  const body = Buffer.concat(contents.map(c =>
    typeof c === 'string' ? Buffer.from(c, 'hex') : c
  ));
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

const seq     = (...c) => tlv(0x30, ...c);
const set_    = (...c) => tlv(0x31, ...c);
const oid     = (hex)  => tlv(0x06, Buffer.from(hex, 'hex'));
const int_    = (b)    => tlv(0x02, b);
const bitStr  = (b)    => tlv(0x03, Buffer.concat([Buffer.from([0x00]), b]));
const null_   = ()     => tlv(0x05, Buffer.alloc(0));
const utf8str = (s)    => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from([0x0c]), encodeLength(b.length), b]); };
const explicit = (n, ...c) => { const body = Buffer.concat(c); return Buffer.concat([Buffer.from([0xa0 | n]), encodeLength(body.length), body]); };

function utcTime(d) {
  // UTCTime: YYMMDDHHMMSSZ
  const pad = n => String(n).padStart(2, '0');
  const s = String(d.getUTCFullYear()).slice(2)
    + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
    + pad(d.getUTCHours())     + pad(d.getUTCMinutes())
    + pad(d.getUTCSeconds())   + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

// OIDs
const OID_SHA256_WITH_RSA = '2a864886f70d01010b'; // 1.2.840.113549.1.1.11
const OID_COMMON_NAME     = '550403';              // 2.5.4.3
const OID_RSA_ENCRYPTION  = '2a864886f70d010101'; // 1.2.840.113549.1.1.1

// ── Certificate builder ───────────────────────────────────────

function generateSelfSignedCert(commonName = 'edge-peer') {
  // Generate RSA-2048 key pair
  const { privateKey: privPem, publicKey: pubDer } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const serial   = crypto.randomBytes(16);
  const now      = new Date();
  const notAfter = new Date(now.getTime() + 10 * 365.25 * 24 * 60 * 60 * 1000);

  // AlgorithmIdentifier for sha256WithRSAEncryption
  const sigAlgId = seq(oid(OID_SHA256_WITH_RSA), null_());

  // RDN: CN=<commonName>
  const rdnCN = seq(set_(seq(oid(OID_COMMON_NAME), utf8str(commonName))));

  // TBSCertificate
  const tbs = seq(
    explicit(0, tlv(0x02, Buffer.from([0x02]))),  // version: v3
    int_(serial),                                   // serialNumber
    sigAlgId,                                       // signature algorithm
    rdnCN,                                          // issuer
    seq(utcTime(now), utcTime(notAfter)),            // validity
    rdnCN,                                          // subject (self-signed = same as issuer)
    Buffer.from(pubDer),                            // subjectPublicKeyInfo
  );

  // Sign TBS
  const signature = crypto.sign('sha256', tbs, privPem);

  // Full Certificate
  const certDer = seq(tbs, sigAlgId, bitStr(signature));
  const certPem = '-----BEGIN CERTIFICATE-----\n'
    + certDer.toString('base64').match(/.{1,64}/g).join('\n')
    + '\n-----END CERTIFICATE-----\n';

  return { cert: certPem, key: privPem };
}

// ── Fingerprint extraction ────────────────────────────────────

function getCertFingerprint(certPem) {
  const x509 = new crypto.X509Certificate(certPem);
  return x509.fingerprint256; // "AA:BB:CC:..." format
}

// ── Persistent cert storage ───────────────────────────────────

function getCertPaths() {
  const dir = path.join(os.homedir(), '.file-share-app');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return {
    cert: path.join(dir, 'peer.crt'),
    key:  path.join(dir, 'peer.key'),
  };
}

/**
 * Load existing cert from disk, or generate + save a new one.
 * Returns { cert, key, fingerprint }.
 */
function loadOrCreateCert() {
  const paths = getCertPaths();
  try {
    if (fs.existsSync(paths.cert) && fs.existsSync(paths.key)) {
      const cert = fs.readFileSync(paths.cert, 'utf8');
      const key  = fs.readFileSync(paths.key,  'utf8');
      // Validate cert is still parseable
      const fp = getCertFingerprint(cert);
      return { cert, key, fingerprint: fp };
    }
  } catch (e) {
    console.warn('[CertGen] Existing cert invalid, regenerating:', e.message);
  }

  console.log('[CertGen] Generating new self-signed certificate…');
  const { cert, key } = generateSelfSignedCert('edge-peer');
  fs.writeFileSync(paths.cert, cert, { mode: 0o600 });
  fs.writeFileSync(paths.key,  key,  { mode: 0o600 });
  const fingerprint = getCertFingerprint(cert);
  console.log('[CertGen] Certificate generated. Fingerprint:', fingerprint.slice(0, 29) + '…');
  return { cert, key, fingerprint };
}

module.exports = { loadOrCreateCert, getCertFingerprint, generateSelfSignedCert };
