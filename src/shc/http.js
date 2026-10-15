// -----------------------------------------------------------------------------
// HTTPS requests to the controller, with node:https only.
//
// The controller serves its API over TLS on the LAN, under a certificate of
// the "Smart Home Controller" authority of Bosch, issued for its own name and
// not for the IP address the user types: the chain is checked against the
// bundled root certificate, the host name is not (as boschshcpy does). The
// client authenticates with the certificate generated during the pairing
// (mutual TLS); the pairing request itself carries the system password.
//
// Every failure is turned into an error with a `kind`, which the hub and the
// actions translate into a message the user can act on.
// -----------------------------------------------------------------------------

import { request as httpsRequest } from 'node:https';

export const ERROR_KINDS = Object.freeze({
  /** No answer at that address: wrong IP, controller off, network down. */
  UNREACHABLE: 'unreachable',
  /** The controller certificate does not chain to the Bosch authority. */
  CERTIFICATE: 'certificate',
  /** The controller refused the client certificate: pairing removed or never done. */
  REFUSED: 'refused',
  /** Pairing only: the controller is not in pairing mode (button not pressed). */
  NOT_PAIRING: 'not_pairing',
  /** Pairing only: the system password was refused. */
  WRONG_PASSWORD: 'wrong_password',
  /** An answer the integration does not understand (HTTP error, bad JSON). */
  PROTOCOL: 'protocol',
});

export class ShcError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message technical detail, never a secret
   * @param {object} [extra] status, code
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ShcError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EPIPE',
]);

// OpenSSL verification failures of the controller certificate.
const CERTIFICATE_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
]);

const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** TLS alerts sent by a server that does not accept the client certificate. */
const isClientCertificateAlert = (err) =>
  /alert (bad certificate|unknown ca|certificate required|certificate unknown|handshake failure|access denied)/i.test(
    err.message ?? '',
  ) ||
  /ERR_SSL_(TLSV13_ALERT_CERTIFICATE_REQUIRED|SSLV3_ALERT_BAD_CERTIFICATE|TLSV1_ALERT_UNKNOWN_CA|TLSV1_ALERT_ACCESS_DENIED)/.test(
    err.code ?? '',
  );

/**
 * Classify a transport error.
 * @param {Error & { code?: string }} err
 * @param {boolean} handshakeDone whether the TLS session was established
 */
export function classify(err, handshakeDone) {
  if (err instanceof ShcError) {
    return err;
  }
  const code = err.code ?? '';
  if (CERTIFICATE_CODES.has(code)) {
    return new ShcError(ERROR_KINDS.CERTIFICATE, `controller certificate refused (${code})`, {
      code,
    });
  }
  if (isClientCertificateAlert(err)) {
    return new ShcError(ERROR_KINDS.REFUSED, 'client certificate refused by the controller', {
      code,
    });
  }
  if (NETWORK_CODES.has(code) || err.name === 'TimeoutError') {
    // A reset before the end of the handshake is the controller closing a
    // TLS session it does not want (a refused client, a closed pairing).
    const kind =
      code === 'ECONNRESET' && !handshakeDone ? ERROR_KINDS.REFUSED : ERROR_KINDS.UNREACHABLE;
    return new ShcError(kind, err.name === 'TimeoutError' ? 'no answer in time' : code, { code });
  }
  if (/^ERR_SSL_|^EPROTO$/.test(code) || /ssl|tls/i.test(err.message ?? '')) {
    return new ShcError(ERROR_KINDS.REFUSED, `TLS session refused (${code || err.message})`, {
      code,
    });
  }
  return new ShcError(ERROR_KINDS.UNREACHABLE, err.message || code || 'request failed', { code });
}

/**
 * One HTTPS request. Resolves `{ status, body }` (body as a string) for any
 * HTTP status; rejects with a ShcError on a transport failure.
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.method
 * @param {string} options.path
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body]
 * @param {string} [options.key] client private key (PEM)
 * @param {string} [options.cert] client certificate (PEM)
 * @param {string} options.ca the authorities the controller certificate must chain to
 * @param {boolean} [options.insecure] accept any controller certificate
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal] cancels the request (the error is an AbortError)
 */
export function request({
  host,
  port,
  method,
  path,
  headers = {},
  body,
  key,
  cert,
  ca,
  insecure = false,
  timeoutMs = 20_000,
  signal,
}) {
  return new Promise((resolve, reject) => {
    let handshakeDone = false;
    let settled = false;
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    const req = httpsRequest({
      host,
      port,
      method,
      path,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Length': String(payload.length) } : {}),
      },
      key,
      cert,
      ca,
      rejectUnauthorized: !insecure,
      // The certificate names the controller, not the address typed by the
      // user: the chain is verified, the host name is not.
      checkServerIdentity: () => undefined,
      // One connection per request: the controller drops idle keep-alive
      // connections without notice (boschshcpy #281).
      agent: false,
      signal,
    });
    const timer = setTimeout(() => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      req.destroy(err);
    }, timeoutMs);
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        handshakeDone = true;
      });
    });
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy(new ShcError(ERROR_KINDS.PROTOCOL, 'answer too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        finish(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', (err) => finish(reject, classify(err, true)));
    });
    req.on('error', (err) => {
      if (err.name === 'AbortError') {
        finish(reject, err);
        return;
      }
      finish(reject, classify(err, handshakeDone));
    });
    req.end(payload);
  });
}
