// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// How long a motion detector stays "motion" after a detection, in seconds.
export const MOTION_HOLD_SECONDS = ['30', '60', '120', '300'];

export const DEFAULT_CONFIG = {
  host: '',
  system_password: '',
  language: 'fr',
  motion_hold_seconds: '60',
  allow_arming: false,
  skip_certificate_check: false,
};

/**
 * The controller address typed by the user: an IP address or a host name,
 * without scheme, port or path (pasted from a browser, they are dropped).
 * @param {unknown} raw
 * @returns {string|null}
 */
export function parseHost(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  let text = raw.trim();
  if (text === '') {
    return null;
  }
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Credentials in the address would end up in the logs.
  if (text.includes('@')) {
    return null;
  }
  text = text.split('/')[0];
  // [IPv6]:port, then host:port.
  const bracketed = text.match(/^\[([0-9a-f:.]+)\](?::\d+)?$/i);
  if (bracketed) {
    return bracketed[1];
  }
  if ((text.match(/:/g) ?? []).length === 1) {
    text = text.split(':')[0];
  }
  if (!/^[a-z0-9.:-]+$/i.test(text) || text.startsWith('.') || text.startsWith('-')) {
    return null;
  }
  return text.toLowerCase();
}

const isTrue = (value) => value === true || value === 'true';

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const typedHost = typeof source.host === 'string' ? source.host.trim() : '';
  const hold = MOTION_HOLD_SECONDS.includes(String(source.motion_hold_seconds))
    ? String(source.motion_hold_seconds)
    : DEFAULT_CONFIG.motion_hold_seconds;
  return {
    host: parseHost(typedHost),
    hostTyped: typedHost !== '',
    // Kept as typed: spaces may be part of it. Only the pairing reads it.
    password: typeof source.system_password === 'string' ? source.system_password : '',
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
    motionHoldMs: Number(hold) * 1000,
    allowArming: isTrue(source.allow_arming),
    insecure: isTrue(source.skip_certificate_check),
  };
}
