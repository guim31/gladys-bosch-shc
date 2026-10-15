// -----------------------------------------------------------------------------
// Client of the local API of the Bosch Smart Home Controller (I and II).
//
//   - port 8443, /smarthome/clients: the pairing (system password, controller
//     in pairing mode after a press on its button);
//   - port 8444, /smarthome/...: the REST API, authenticated by the client
//     certificate registered during the pairing;
//   - port 8444, /remote/json-rpc: the long polling of the events
//     (RE/subscribe, RE/longPoll, RE/unsubscribe);
//   - port 8446, /smarthome/public/information: unauthenticated, read-only
//     controller information (used by scripts/probe.mjs).
//
// Protocol learnt from boschshcpy (BSD-3-Clause) and from the public
// "Bosch Smart Home Controller Local REST API" documentation.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { ERROR_KINDS, ShcError, request } from './http.js';

export const BOSCH_ROOT_CA = readFileSync(new URL('./bosch-root-ca.pem', import.meta.url), 'utf8');

export const DEFAULT_PORTS = Object.freeze({ pairing: 8443, api: 8444, public: 8446 });

// The API version boschshcpy speaks; the controller answers older clients too.
const API_VERSION = '3.2';

// Longest wait of one long-poll request, in seconds (the request itself is
// given a few more seconds before it counts as lost).
export const LONG_POLL_SECONDS = 30;

/** Device ids of child devices carry a `#`, which must be escaped in a path. */
const pathId = (id) => String(id).replaceAll('#', '%23');

function parseJson(text, what) {
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ShcError(ERROR_KINDS.PROTOCOL, `${what}: the answer is not JSON`);
  }
}

/** The error code of a refusal body (`{ "errorCode": "..." }`), if any. */
function errorCodeOf(text) {
  try {
    const body = JSON.parse(text);
    return typeof body?.errorCode === 'string' ? body.errorCode : null;
  } catch {
    return null;
  }
}

export class ShcClient {
  /**
   * @param {object} options
   * @param {string} options.host the controller IP address (or host name)
   * @param {string} [options.key] client private key (PEM), once paired
   * @param {string} [options.cert] client certificate (PEM), once paired
   * @param {string} [options.ca] trusted authorities (default: the Bosch root)
   * @param {boolean} [options.insecure] skip the controller certificate check
   * @param {Partial<typeof DEFAULT_PORTS>} [options.ports] (tests)
   * @param {number} [options.timeoutMs]
   */
  constructor({ host, key, cert, ca = BOSCH_ROOT_CA, insecure = false, ports, timeoutMs }) {
    this.host = host;
    this.key = key;
    this.cert = cert;
    this.ca = ca;
    this.insecure = insecure;
    this.ports = { ...DEFAULT_PORTS, ...ports };
    this.timeoutMs = timeoutMs ?? 20_000;
  }

  async call(method, path, { body, port = this.ports.api, timeoutMs, signal, what } = {}) {
    const answer = await request({
      host: this.host,
      port,
      method,
      path,
      headers: {
        'api-version': API_VERSION,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      key: this.key,
      cert: this.cert,
      ca: this.ca,
      insecure: this.insecure,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      signal,
    });
    const label = what ?? `${method} ${path}`;
    if (answer.status === 401 || answer.status === 403) {
      throw new ShcError(ERROR_KINDS.REFUSED, `${label}: HTTP ${answer.status}`, {
        status: answer.status,
      });
    }
    if (answer.status < 200 || answer.status >= 300) {
      const code = errorCodeOf(answer.body);
      throw new ShcError(
        ERROR_KINDS.PROTOCOL,
        `${label}: HTTP ${answer.status}${code ? ` ${code}` : ''}`,
        { status: answer.status, errorCode: code },
      );
    }
    return parseJson(answer.body, label);
  }

  // --- REST API --------------------------------------------------------------

  /** The controller itself: software version, update state… */
  information() {
    return this.call('GET', '/smarthome/information');
  }

  async devices() {
    return asArray(await this.call('GET', '/smarthome/devices'), 'devices');
  }

  /** Every service of every device, with its state, in one request. */
  async services() {
    return asArray(await this.call('GET', '/smarthome/services'), 'services');
  }

  async deviceServices(deviceId) {
    return asArray(
      await this.call('GET', `/smarthome/devices/${pathId(deviceId)}/services`),
      'device services',
    );
  }

  async rooms() {
    return asArray(await this.call('GET', '/smarthome/rooms'), 'rooms');
  }

  /**
   * The intrusion detection system. A controller without one answers an
   * error: resolved as `null`.
   */
  async intrusionState() {
    try {
      return await this.call('GET', '/smarthome/intrusion/states/system');
    } catch (err) {
      if (err.kind === ERROR_KINDS.PROTOCOL && err.status >= 400 && err.status < 500) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Change the state of a device service (only the keys given).
   * @param {string} deviceId
   * @param {string} serviceId e.g. PowerSwitch
   * @param {object} state including its `@type`
   */
  putState(deviceId, serviceId, state) {
    return this.call('PUT', `/smarthome/devices/${pathId(deviceId)}/services/${serviceId}/state`, {
      body: state,
    });
  }

  /** Arm the intrusion detection system with a profile ("0", "1" or "2"). */
  arm(profileId) {
    return this.call('POST', '/smarthome/intrusion/actions/arm', {
      body: { '@type': 'armRequest', profileId: String(profileId) },
    });
  }

  // --- Long polling ------------------------------------------------------------

  async rpc(method, params, options = {}) {
    const answer = await this.call('POST', '/remote/json-rpc', {
      body: [{ jsonrpc: '2.0', method, params }],
      what: method,
      ...options,
    });
    const [first] = Array.isArray(answer) ? answer : [];
    if (!first || first.jsonrpc !== '2.0') {
      throw new ShcError(ERROR_KINDS.PROTOCOL, `${method}: malformed JSON-RPC answer`);
    }
    if (first.error) {
      throw new ShcError(
        ERROR_KINDS.PROTOCOL,
        `${method}: JSON-RPC error ${first.error.code} ${first.error.message ?? ''}`.trim(),
        { rpcCode: first.error.code },
      );
    }
    return first.result;
  }

  /** Open an event subscription; resolves its id. */
  async subscribe() {
    const id = await this.rpc('RE/subscribe', ['com/bosch/sh/remote/*', null]);
    if (typeof id !== 'string' || id === '') {
      throw new ShcError(ERROR_KINDS.PROTOCOL, 'RE/subscribe: no subscription id');
    }
    return id;
  }

  /**
   * Wait for the next events of a subscription (an empty array after
   * `seconds` without any).
   */
  async longPoll(pollId, { seconds = LONG_POLL_SECONDS, signal } = {}) {
    const result = await this.rpc('RE/longPoll', [pollId, seconds], {
      timeoutMs: (seconds + 10) * 1000,
      signal,
    });
    return Array.isArray(result) ? result : [];
  }

  unsubscribe(pollId) {
    return this.rpc('RE/unsubscribe', [pollId], { timeoutMs: 5_000 });
  }

  // --- Without a client certificate ----------------------------------------------

  /** Public, unauthenticated information (generation, software version). */
  publicInformation() {
    return new ShcClient({ ...this, key: undefined, cert: undefined }).call(
      'GET',
      '/smarthome/public/information',
      { port: this.ports.public },
    );
  }

  /**
   * Register a client certificate. The controller must be in pairing mode
   * (its button pressed until the lights flash): otherwise it closes the TLS
   * session, reported as NOT_PAIRING.
   * @param {object} options
   * @param {string} options.password the system password of the controller
   * @param {string} options.clientId
   * @param {string} options.name client name shown in the Bosch app
   * @param {string} options.certificate the one-line certificate (x509.pairingCertificate)
   * @returns {Promise<object>} the controller answer (`{ token }`)
   */
  async pair({ password, clientId, name, certificate }) {
    let answer;
    try {
      answer = await request({
        host: this.host,
        port: this.ports.pairing,
        method: 'POST',
        path: '/smarthome/clients',
        headers: {
          'Content-Type': 'application/json',
          Systempassword: Buffer.from(password, 'utf8').toString('base64'),
        },
        body: JSON.stringify({
          '@type': 'client',
          id: clientId,
          name,
          primaryRole: 'ROLE_RESTRICTED_CLIENT',
          certificate,
        }),
        ca: this.ca,
        insecure: this.insecure,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      // A controller outside pairing mode refuses the TLS session on 8443.
      if (err.kind === ERROR_KINDS.REFUSED) {
        throw new ShcError(ERROR_KINDS.NOT_PAIRING, `pairing refused: ${err.message}`, {
          code: err.code,
        });
      }
      throw err;
    }
    if (answer.status === 401 || answer.status === 403) {
      throw new ShcError(ERROR_KINDS.WRONG_PASSWORD, `pairing: HTTP ${answer.status}`, {
        status: answer.status,
      });
    }
    if (answer.status < 200 || answer.status >= 300) {
      const code = errorCodeOf(answer.body);
      throw new ShcError(
        ERROR_KINDS.PROTOCOL,
        `pairing: HTTP ${answer.status}${code ? ` ${code}` : ''}`,
        { status: answer.status, errorCode: code },
      );
    }
    return parseJson(answer.body, 'pairing') ?? {};
  }
}

function asArray(value, what) {
  if (!Array.isArray(value)) {
    throw new ShcError(ERROR_KINDS.PROTOCOL, `${what}: a list was expected`);
  }
  return value;
}
