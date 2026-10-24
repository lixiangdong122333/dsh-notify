// Unit tests for the loopback route gate.
//
// The gate protects the plugin's own routes, so these cases are the contract:
// a loopback page carrying the header may proceed, everything else is refused
// with a short reason the Host returns as 403.
import { bareHostname, gateRequest, isLoopbackHostname, splitHost } from './route-gate.js';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
}

/** A request shaped like Node's IncomingMessage, with only what the gate reads. */
function request({ host = '127.0.0.1:51172', header = '1', origin, remote = '127.0.0.1' } = {}) {
  // `null` means the header is deliberately absent; `undefined` would fall back
  // to the default argument, which is not what these cases want to send.
  const headers = {};
  if (host !== null) headers.host = host;
  if (header !== null) headers['x-dsh-notify'] = header;
  if (origin !== undefined) headers.origin = origin;
  return { headers, socket: { remoteAddress: remote } };
}

// --- hostnames ---------------------------------------------------------------
check('brackets are dropped from IPv6 literals',
  bareHostname('[::1]') === '::1', bareHostname('[::1]'));
check('loopback names are recognised',
  ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]'].every(isLoopbackHostname));
check('non-loopback names are rejected',
  ['10.0.0.1', '192.168.1.5', '127.0.0.1.evil.example', 'example.com', '']
    .every(value => !isLoopbackHostname(value)));

check('a plain host and port split',
  JSON.stringify(splitHost('127.0.0.1:3080')) === JSON.stringify({ hostname: '127.0.0.1', port: '3080' }));
check('a bracketed IPv6 host and port split',
  JSON.stringify(splitHost('[::1]:3080')) === JSON.stringify({ hostname: '::1', port: '3080' }));
check('a host without a port splits', JSON.stringify(splitHost('localhost')) === JSON.stringify({ hostname: 'localhost', port: '' }));
check('a malformed host is null', splitHost('bad host') === null && splitHost(undefined) === null);

// --- the gate ---------------------------------------------------------------
check('a loopback page with the header proceeds', gateRequest(request()) === null);
check('the desktop shell origin is accepted',
  gateRequest(request({ origin: 'dsh-app://app' })) === null);
check('a matching http origin is accepted',
  gateRequest(request({ origin: 'http://127.0.0.1:51172' })) === null);
check('a matching https origin with the default port is accepted',
  gateRequest(request({ host: '127.0.0.1:443', origin: 'https://127.0.0.1' })) === null);

check('a missing header is refused',
  gateRequest(request({ header: null })) === 'forbidden');
check('a wrong header value is refused',
  gateRequest(request({ header: '0' })) === 'forbidden');
check('a non-loopback peer is refused',
  gateRequest(request({ remote: '10.0.0.9' })) === 'bad-remote');
check('an IPv4-mapped peer is unwrapped before the check',
  gateRequest(request({ remote: '::ffff:127.0.0.1' })) === null);
check('a non-loopback Host is refused (DNS rebinding)',
  gateRequest(request({ host: 'evil.example:51172' })) === 'bad-host');
check('a missing Host is refused', gateRequest(request({ host: null })) === 'bad-host');
check('a cross-origin Origin is refused',
  gateRequest(request({ origin: 'http://evil.example' })) === 'cross-origin');
check('an Origin with a different port is refused',
  gateRequest(request({ origin: 'http://127.0.0.1:9999' })) === 'cross-origin');
check('a non-http Origin is refused',
  gateRequest(request({ origin: 'ftp://127.0.0.1' })) === 'cross-origin');
check('another app scheme is refused',
  gateRequest(request({ origin: 'dsh-app://other' })) === 'cross-origin');

// --- report ------------------------------------------------------------------
const failed = results.filter(result => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok || !result.detail ? '' : `  (${result.detail})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
