// Request gate for the plugin's own browser-facing routes.
//
// `/dsh-notify/config` writes the profile patch, `/dsh-notify/test` spawns a
// notifier, and `/dsh-notify/focus` feeds the focus suppression. All three are
// reachable from the loopback web server, so they share one gate:
//
//   * a cross-origin page cannot add `x-dsh-notify` without a CORS preflight
//     this server never answers, so the header is the CSRF gate;
//   * a DNS-rebinding page *is* same-origin with the name it resolved, so it can
//     add the header — but the browser fills `Host` from that name, and the gate
//     only accepts a loopback `Host`, which a rebound page cannot produce;
//   * the desktop shell forwards `dsh-app://app` requests to the host server, so
//     that one origin is accepted explicitly.
//
// The TCP peer is checked too: it costs nothing and makes a proxied or
// port-forwarded request fail closed instead of relying on headers alone.
//
// The gate is deliberately loopback-only. A DSH host exposed on a LAN address
// answers these routes with 403; the settings page is local-only by design.

/** Header that proves the caller could add a non-safelisted request header. */
export const GATE_HEADER = 'x-dsh-notify';

/** Value {@link GATE_HEADER} must carry. */
export const GATE_VALUE = '1';

/** Origin the desktop shell uses when it forwards the page's requests. */
export const DESKTOP_ORIGIN = 'dsh-app://app';

/**
 * Lower-case a hostname and drop the brackets an IPv6 literal carries.
 * @param {string} value
 * @returns {string}
 */
export function bareHostname(value) {
  return String(value).toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '');
}

/**
 * Whether a hostname names the loopback interface.
 * @param {string} value
 * @returns {boolean}
 */
export function isLoopbackHostname(value) {
  const text = bareHostname(value);
  if (text === 'localhost' || text === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/u.test(text);
}

/**
 * Split one `Host` header into hostname and port.
 * @param {unknown} value the raw header
 * @returns {{ hostname: string, port: string } | null}
 */
export function splitHost(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const bracketed = text.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/u);
  if (bracketed !== null) return { hostname: bracketed[1], port: bracketed[2] ?? '' };
  const plain = text.match(/^([A-Za-z0-9._-]+)(?::(\d{1,5}))?$/u);
  if (plain === null) return null;
  return { hostname: plain[1], port: plain[2] ?? '' };
}

/**
 * Decide whether one request may touch a plugin route.
 * @param {import('node:http').IncomingMessage} req
 * @returns {'bad-remote' | 'bad-host' | 'cross-origin' | 'forbidden' | null}
 *   a short refusal reason, or null when the request may proceed
 */
export function gateRequest(req) {
  const remote = String(req?.socket?.remoteAddress ?? '').replace(/^::ffff:/iu, '');
  if (!isLoopbackHostname(remote)) return 'bad-remote';

  const host = splitHost(req?.headers?.host);
  if (host === null || !isLoopbackHostname(host.hostname)) return 'bad-host';

  const origin = req?.headers?.origin;
  if (typeof origin === 'string' && origin.length > 0 && origin !== DESKTOP_ORIGIN) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return 'cross-origin';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'cross-origin';
    if (bareHostname(parsed.hostname) !== bareHostname(host.hostname)) return 'cross-origin';
    const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
    if ((parsed.port || defaultPort) !== (host.port || defaultPort)) return 'cross-origin';
  }

  if (req?.headers?.[GATE_HEADER] !== GATE_VALUE) return 'forbidden';
  return null;
}
