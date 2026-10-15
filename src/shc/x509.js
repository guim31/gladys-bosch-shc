// -----------------------------------------------------------------------------
// A minimal X.509 certificate builder, on top of node:crypto.
//
// The controller pairs a client by its certificate: the integration generates
// an RSA key pair and a self-signed certificate, sends the certificate during
// the pairing, then authenticates every request with that pair (mutual TLS).
// node:crypto creates keys and signatures but no certificate, and a library
// for this one structure would weigh more than the integration itself: this
// module encodes the few DER structures a certificate needs (RFC 5280).
//
// The certificate mirrors the one boschshcpy generates (BSD-3-Clause, by
// Clemens-Alexander Brust and Thomas Schamm): RSA 2048, SHA-256, subject
// CN=<client id> O=<name>, self-signed, ten years, basicConstraints CA.
// -----------------------------------------------------------------------------

import { KeyObject, createPublicKey, generateKeyPair, randomBytes, sign } from 'node:crypto';
import { promisify } from 'node:util';

const generateKeyPairAsync = promisify(generateKeyPair);

const OID = {
  sha256WithRSAEncryption: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  organizationName: '2.5.4.10',
  basicConstraints: '2.5.29.19',
};

// --- DER encoding ------------------------------------------------------------

function length(size) {
  if (size < 0x80) {
    return Buffer.from([size]);
  }
  const bytes = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), length(content.length), content]);

const sequence = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const explicit = (number, content) => tlv(0xa0 + number, content);
const nullValue = () => Buffer.from([0x05, 0x00]);
const boolean = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const octetString = (content) => tlv(0x04, content);
const bitString = (content) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), content]));
const utf8String = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));

/** A non-negative INTEGER from big-endian bytes (a 0x00 keeps it positive). */
function integer(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start += 1;
  }
  const trimmed = bytes.subarray(start);
  return tlv(0x02, trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function objectIdentifier(dotted) {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) {
      chunk.unshift((value & 0x7f) | 0x80);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime until 2049, GeneralizedTime after (RFC 5280, 4.1.2.5). */
function time(date) {
  const iso = date.toISOString(); // 2026-10-15T08:00:00.000Z
  const digits = iso.slice(0, 19).replace(/[-:T]/g, '') + 'Z'; // 20261015080000Z
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(digits.slice(2), 'ascii'))
    : tlv(0x18, Buffer.from(digits, 'ascii'));
}

function name({ commonName, organization }) {
  const attributes = [set(sequence(objectIdentifier(OID.commonName), utf8String(commonName)))];
  if (organization) {
    attributes.push(
      set(sequence(objectIdentifier(OID.organizationName), utf8String(organization))),
    );
  }
  return sequence(...attributes);
}

const pem = (label, der) =>
  `-----BEGIN ${label}-----\n${der
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n')}\n-----END ${label}-----\n`;

// --- Certificates ------------------------------------------------------------

/** A public KeyObject from a public or private key, KeyObject or PEM. */
const asPublicKey = (key) =>
  key instanceof KeyObject && key.type === 'public' ? key : createPublicKey(key);

/**
 * Build and sign a certificate.
 * @param {object} options
 * @param {{ commonName: string, organization?: string }} options.subject
 * @param {{ commonName: string, organization?: string }} [options.issuer] default: the subject
 * @param {import('node:crypto').KeyObject|string} options.publicKey the certified key
 * @param {import('node:crypto').KeyObject|string} options.signingKey the issuer's private key
 * @param {Date} [options.notBefore]
 * @param {Date} [options.notAfter]
 * @param {boolean} [options.ca] basicConstraints cA (critical)
 * @param {Buffer} [options.serial] positive serial number bytes (random by default)
 * @returns {string} the certificate, PEM encoded
 */
export function createCertificate({
  subject,
  issuer = subject,
  publicKey,
  signingKey,
  notBefore = new Date(),
  notAfter = new Date(notBefore.getTime() + 10 * 365 * 24 * 3600 * 1000),
  ca = true,
  serial = randomBytes(8),
}) {
  const algorithm = sequence(objectIdentifier(OID.sha256WithRSAEncryption), nullValue());
  const spki = asPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  const extensions = explicit(
    3,
    sequence(
      sequence(
        objectIdentifier(OID.basicConstraints),
        boolean(true),
        octetString(ca ? sequence(boolean(true)) : sequence()),
      ),
    ),
  );
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    algorithm,
    name(issuer),
    sequence(time(notBefore), time(notAfter)),
    name(subject),
    spki,
    extensions,
  );
  const signature = sign('sha256', tbs, signingKey);
  return pem('CERTIFICATE', sequence(tbs, algorithm, bitString(signature)));
}

/**
 * Generate the client identity sent to the controller during the pairing.
 * @param {object} options
 * @param {string} options.clientId the certificate common name
 * @param {string} options.organization
 * @param {Date} [options.now]
 * @returns {Promise<{ keyPem: string, certPem: string }>}
 */
export async function generateClientIdentity({ clientId, organization, now = new Date() }) {
  const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const certPem = createCertificate({
    subject: { commonName: clientId, organization },
    publicKey,
    signingKey: privateKey,
    notBefore: now,
  });
  // PKCS#1, like the "TraditionalOpenSSL" key boschshcpy writes.
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  return { keyPem, certPem };
}

/**
 * The certificate in the one-line form the pairing request carries: the
 * base64 body without line breaks, framed by `\r` (as boschshcpy sends it).
 * @param {string} certPem
 */
export function pairingCertificate(certPem) {
  const body = certPem
    .replace('-----BEGIN CERTIFICATE-----', '')
    .replace('-----END CERTIFICATE-----', '')
    .replace(/\s+/g, '');
  return `-----BEGIN CERTIFICATE-----\r${body}\r-----END CERTIFICATE-----`;
}
