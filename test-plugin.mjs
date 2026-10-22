// Offline harness for @cmwl1231/dsh-notify.
//
// Runs the real plugin module against a fake Cordis context and a fake session
// log so the turn-end and question paths can be exercised without installing
// anything. `spawn` is replaced so no toast is raised during the run.
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const spawned = [];
childProcess.spawn = (command, args, options) => {
  const fake = new EventEmitter();
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  fake.unref = () => {};
  spawned.push({ command, args, options });
  queueMicrotask(() => fake.emit('exit', 0));
  return fake;
};
syncBuiltinESMExports();

const { apply, inject, Config } = await import('./index.js');
const { normalize } = await import('./schema.js');
const { writeConfig } = await import('./settings-store.js');
const { readFileSync, writeFileSync, unlinkSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');

function makeContext() {
  const listeners = new Map();
  const routes = new Map();
  const indexInjections = [];
  const log = [];
  const ctx = {
    log,
    logger: {
      debug: (line) => log.push(line),
      warn: (line) => log.push(`WARN ${line}`),
    },
    on(name, handler) {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
      return () => {
        const current = listeners.get(name) ?? [];
        listeners.set(name, current.filter(entry => entry !== handler));
      };
    },
    effect(fn, id) {
      log.push(`effect:${id}`);
      fn();
      return () => {};
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    emit(name, ...args) {
      for (const handler of listeners.get(name) ?? []) handler(...args);
    },
    listeners,
    routes,
    indexInjections,
  };
  return ctx;
}

function makeSession({ id, cwd, events = [], origin }) {
  return {
    id,
    seq: events.length,
    header: { id, cwd, ...(origin ? { origin } : {}) },
    snapshotEvents: () => events,
  };
}

function userMessage(text) {
  return { type: 'user/message', time: Date.now(), seq: 0, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } };
}

function assistantMessage(text) {
  return { type: 'assistant/message', time: Date.now(), seq: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } };
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
}

// --- turn end ---------------------------------------------------------------
const ctx = makeContext();
apply(ctx, { skipWhenFocused: false, questionDelayMs: 5, cwd: null });

const events = [userMessage('把 dsh-notify 插件做完'), assistantMessage('插件已经装好了，点击通知可以回到 DSH。')];
const session = makeSession({ id: 'session-test-1', cwd: 'C:\\work', events });

ctx.emit('agent/created', { agent: { id: 'session-test-1', session, status: 'idle' } });
ctx.emit('session/event', session, { type: 'turn/start', time: Date.now() - 50 });
ctx.emit('session/event', session, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } });

await new Promise(resolve => setTimeout(resolve, 50));
check('turn end raises one toast', spawned.length === 1, `spawned=${spawned.length}`);
const toast = spawned[0];
check('toast uses powershell.exe', toast?.command === 'powershell.exe');
check('toast passes the notify script', toast?.args?.some(arg => arg.endsWith('notify.ps1')), JSON.stringify(toast?.args));
const bodyIndex = toast?.args?.indexOf('-Body') ?? -1;
check('toast body is the assistant answer', bodyIndex > 0 && toast.args[bodyIndex + 1].startsWith('插件已经装好了'));
const protocolIndex = toast?.args?.indexOf('-Activate') ?? -1;
check('toast activates dsh://notify', protocolIndex > 0 && toast.args[protocolIndex + 1] === 'dsh://notify');

// --- user cancellation stays silent ----------------------------------------
spawned.length = 0;
ctx.emit('session/event', session, { type: 'turn/start', time: Date.now() });
ctx.emit('session/event', session, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } });
await new Promise(resolve => setTimeout(resolve, 30));
check('user-cancelled turn is silent', spawned.length === 0, `spawned=${spawned.length}`);

// --- subagent sessions stay silent -----------------------------------------
spawned.length = 0;
const child = makeSession({ id: 'session-child', cwd: 'C:\\work', origin: 'subagent' });
ctx.emit('agent/created', { agent: { id: 'session-child', session: child, status: 'idle' } });
ctx.emit('session/event', child, { type: 'turn/start', time: Date.now() });
ctx.emit('session/event', child, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } });
await new Promise(resolve => setTimeout(resolve, 30));
check('subagent session is ignored', spawned.length === 0, `spawned=${spawned.length}`);

// --- question raises a toast after the delay --------------------------------
spawned.length = 0;
const askSession = makeSession({ id: 'session-ask', cwd: 'C:\\work' });
const agent = { id: 'session-ask', session: askSession, status: 'running' };
ctx.emit('agent/created', { agent });
const questionPromise = ctx.listeners.get('user-questions/request')[0](
  { agent, questions: [{ id: 'q1', header: '确认', question: '要现在重启 DSH 吗？', options: [] }], signal: new AbortController().signal },
  () => Promise.resolve({ answers: [] }),
);
await new Promise(resolve => setTimeout(resolve, 60));
check('pending question raises a toast', spawned.length === 1, `spawned=${spawned.length}`);
const questionBody = spawned[0]?.args?.[spawned[0].args.indexOf('-Body') + 1] ?? '';
check('question toast names the question', questionBody.includes('重启'), questionBody);
const answered = await Promise.race([questionPromise, new Promise(resolve => setTimeout(() => resolve('pending'), 300))]);
check('question listener steps aside after the delay', answered !== 'pending');

// --- plan reviews stay quiet by default -------------------------------------
spawned.length = 0;
const planRequest = ctx.listeners.get('user-questions/request')[0](
  { agent, questions: [{ id: 'q2', question: '批准这个计划吗？', intent: { kind: 'plan-review', approve: '批准', detail: '计划正文' } }], signal: new AbortController().signal },
  () => Promise.resolve({ answers: [] }),
);
await new Promise(resolve => setTimeout(resolve, 60));
check('plan review is not announced', spawned.length === 0, `spawned=${spawned.length}`);
check('plan review falls through to the answerer at once', (await planRequest)?.answers !== undefined);

// --- focus gating -----------------------------------------------------------
spawned.length = 0;
const focused = makeContext();
apply(focused, { skipWhenFocused: true });
const route = focused.routes.get('/dsh-notify/focus');
await new Promise((resolve) => {
  const headers = {};
  route.handler({ url: '/dsh-notify/focus?on=tab-1' }, { writeHead: (code) => { headers.code = code; }, end: () => { headers.end = true; resolve(); } });
  check('focus report accepted', headers.code === 204);
});
const focusedSession = makeSession({ id: 'session-focused', cwd: 'C:\\work', events: [assistantMessage('done')] });
focused.emit('agent/created', { agent: { id: 'session-focused', session: focusedSession, status: 'idle' } });
focused.emit('session/event', focusedSession, { type: 'turn/start', time: Date.now() });
focused.emit('session/event', focusedSession, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } });
await new Promise(resolve => setTimeout(resolve, 30));
check('focused tab suppresses the toast', spawned.length === 0, `spawned=${spawned.length}`);

const focusScript = focused.routes.get('/dsh-notify-focus.js');
let scriptText = '';
focusScript.handler({}, { writeHead: () => {}, end: (text) => { scriptText = text ?? ''; } });
check('focus script is served', scriptText.includes('/dsh-notify/focus'));

// --- wiring -----------------------------------------------------------------
check('plugin injects the host services it uses', JSON.stringify(inject) === '["agents","webServer"]', JSON.stringify(inject));
check('disposers registered', ctx.log.some(line => line.startsWith('effect:')));

// --- configuration ----------------------------------------------------------

// The Harness projects a Config into the settings UI only when it is a
// Schemastery instance, so this identity check is what makes the settings page
// appear at all; a plain Standard Schema leaves it empty.
check('Config is a Schemastery instance', Config[Symbol.for('schemastery')] === true);
check('Config carries a string type', typeof Config.type === 'string');
check('Config carries a meta object', Config.meta !== null && typeof Config.meta === 'object');
check('Config applies defaults', Config({}).onTurnEnd === true);
check('Config rejects a bad enum value', (() => {
  try { Config({ bodySource: 'bogus' }); return false; } catch { return true; }
})());

// normalize() is what the plugin actually reads, so its fallbacks matter more
// than the raw schema.
const defaults = normalize({});
check('default endings are completed/error/max-tokens',
  ['completed', 'error', 'max-tokens'].every(kind => defaults.notifyEndKinds.has(kind)) && !defaults.notifyEndKinds.has('aborted'),
  [...defaults.notifyEndKinds].join(','));
check('default body source is the answer', defaults.bodySource === 'answer', defaults.bodySource);
check('unknown body source falls back', normalize({ bodySource: 'bogus' }).bodySource === 'answer');
check('body length is clamped', normalize({ bodyLength: 9999 }).bodyLength === 500, String(normalize({ bodyLength: 9999 }).bodyLength));
check('custom titles survive normalize', normalize({ titleCompleted: '  完成啦  ' }).titleCompleted === '完成啦');
check('empty custom title falls back', normalize({ titleCompleted: '   ' }).titleCompleted === 'DSH · 任务完成');

/** Run one turn through a fresh plugin instance and report what it raised. */
async function turnWith(override, { kind = 'completed', events: turnEvents } = {}) {
  const local = makeContext();
  apply(local, { skipWhenFocused: false, questionDelayMs: 5, ...override });
  const log = turnEvents ?? [userMessage('原始提问'), assistantMessage('最终回答')];
  const s = makeSession({ id: `s-${Math.random()}`, cwd: 'C:\\work', events: log });
  local.emit('agent/created', { agent: { id: s.id, session: s, status: 'idle' } });
  local.emit('session/event', s, { type: 'turn/start', time: Date.now() });
  local.emit('session/event', s, { type: 'turn/end', time: Date.now(), data: { reason: { kind } } });
  await new Promise(resolve => setTimeout(resolve, 30));
  return { local, sends: [...spawned] };
}

/** Read a `-Flag value` pair out of a spawn argument list. */
function flagValue(args, flag) {
  const index = args?.indexOf(flag) ?? -1;
  return index > 0 ? args[index + 1] : undefined;
}

spawned.length = 0;
const errorTurn = await turnWith({ notifyEndKinds: ['completed'] }, { kind: 'error' });
check('unselected ending stays silent', errorTurn.sends.length === 0, `spawned=${errorTurn.sends.length}`);

spawned.length = 0;
const abortedTurn = await turnWith({ notifyEndKinds: ['completed', 'aborted'] }, { kind: 'aborted' });
check('aborted notifies when selected', abortedTurn.sends.length === 1, `spawned=${abortedTurn.sends.length}`);

spawned.length = 0;
const promptTurn = await turnWith({ bodySource: 'prompt' });
check('bodySource=prompt uses my own prompt',
  flagValue(promptTurn.sends[0]?.args, '-Body') === '原始提问',
  String(flagValue(promptTurn.sends[0]?.args, '-Body')));

spawned.length = 0;
const titleOnly = await turnWith({ bodySource: 'none' });
const titleOnlyArgs = titleOnly.sends[0]?.args ?? [];
check('bodySource=none omits -Body', !titleOnlyArgs.includes('-Body'), JSON.stringify(titleOnlyArgs));

spawned.length = 0;
const customTitles = await turnWith({ titleCompleted: '我的完成标题' });
check('custom title reaches the toast',
  flagValue(customTitles.sends[0]?.args, '-Title') === '我的完成标题',
  String(flagValue(customTitles.sends[0]?.args, '-Title')));

spawned.length = 0;
const silentTurn = await turnWith({ sound: 'silent' });
check('sound=silent passes -Sound silent', flagValue(silentTurn.sends[0]?.args, '-Sound') === 'silent');

spawned.length = 0;
const importantTurn = await turnWith({ sound: 'important' });
check('sound=important silences a turn ending', flagValue(importantTurn.sends[0]?.args, '-Sound') === 'silent');

// A second session still running must not block when the user opted out.
spawned.length = 0;
const otherCtx = makeContext();
apply(otherCtx, { skipWhenFocused: false, questionDelayMs: 5, skipWhenOthersRunning: false });
const firstSession = makeSession({ id: 's-busy', cwd: 'C:\\work', events: [userMessage('a'), assistantMessage('b')] });
const secondSession = makeSession({ id: 's-done', cwd: 'C:\\work', events: [userMessage('c'), assistantMessage('d')] });
for (const s of [firstSession, secondSession]) {
  otherCtx.emit('agent/created', { agent: { id: s.id, session: s, status: 'idle' } });
  otherCtx.emit('session/event', s, { type: 'turn/start', time: Date.now() });
}
otherCtx.emit('session/event', secondSession, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } });
await new Promise(resolve => setTimeout(resolve, 30));
check('skipWhenOthersRunning=false notifies while another runs', spawned.length === 1, `spawned=${spawned.length}`);

// ...and must stay quiet under the default.
spawned.length = 0;
const busyCtx = makeContext();
apply(busyCtx, { skipWhenFocused: false, questionDelayMs: 5 });
const busyA = makeSession({ id: 's-a', cwd: 'C:\\work', events: [userMessage('a'), assistantMessage('b')] });
const busyB = makeSession({ id: 's-b', cwd: 'C:\\work', events: [userMessage('c'), assistantMessage('d')] });
for (const s of [busyA, busyB]) {
  busyCtx.emit('agent/created', { agent: { id: s.id, session: s, status: 'idle' } });
  busyCtx.emit('session/event', s, { type: 'turn/start', time: Date.now() });
}
busyCtx.emit('session/event', busyB, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } });
await new Promise(resolve => setTimeout(resolve, 30));
check('default stays quiet while another session runs', spawned.length === 0, `spawned=${spawned.length}`);

// The settings page's test button posts to this route.
const testRoute = ctx.routes.get('/dsh-notify/test');
check('test route is registered', testRoute !== undefined);
if (testRoute) {
  let status = 0;
  let payload = '';
  testRoute.handler({}, {
    writeHead: (code) => { status = code; },
    end: (text) => { payload = text ?? ''; },
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  let parsed = {};
  try { parsed = JSON.parse(payload); } catch { parsed = { parseFailed: true }; }
  check('test route answers JSON', parsed.parseFailed !== true, payload);
  check('test route reports success', parsed.ok === true, payload);
  check('test route sent a toast', spawned.length >= 1, `spawned=${spawned.length}`);
}

// The settings page reads and writes its values through this route pair, and the
// round trip must reach the live options the plugin actually consults.
const configRoute = ctx.routes.get('/dsh-notify/config');
check('config route is registered', configRoute !== undefined);

if (configRoute) {
  const call = (method, body) => new Promise((resolve) => {
    let payload = '';
    const req = {
      method,
      on: (event, handler) => {
        if (event === 'data') handler(JSON.stringify(body ?? {}));
        if (event === 'end') handler();
      },
    };
    configRoute.handler(req, {
      writeHead: () => {},
      end: (text) => { payload = text ?? ''; },
    });
    // GET answers synchronously; the POST path finishes on its own 'end'.
    setTimeout(() => {
      try { resolve(JSON.parse(payload)); } catch { resolve({ parseFailed: true, payload }); }
    }, 20);
  });

  const read = await call('GET');
  check('config route reports the live settings', read.ok === true && read.config?.sound === 'default', JSON.stringify(read).slice(0, 160));
  check('config route exposes the ending kinds as a list', Array.isArray(read.config?.notifyEndKinds), JSON.stringify(read.config?.notifyEndKinds));

  const written = await call('POST', { config: { ...read.config, sound: 'silent', bodyLength: 240 } });
  check('config write is accepted', written.ok === true, JSON.stringify(written).slice(0, 160));
  check('config write updates the live options', written.config?.sound === 'silent' && written.config?.bodyLength === 240);

  // Turn focus suppression off around this turn: an earlier case in this file
  // reports the tab as focused, and that would silence the toast for a reason
  // unrelated to the setting under test.
  const beforeFocusWrite = await call('POST', { config: { ...written.config, skipWhenFocused: false } });
  check('focus suppression can be turned off through the same route', beforeFocusWrite.config?.skipWhenFocused === false);

  // Persistence is a different concern from the live update: test the store on a
  // throwaway patch file so the real profile is never touched by this suite.
  const scratch = join(tmpdir(), `dsh-notify-patch-${process.pid}.yml`);
  writeFileSync(scratch, [
    '# a comment that must survive',
    '- id: some-other-plugin',
    '  name: "@x/y"',
    '  config:',
    '    keep: me',
    '- id: dsh-notify',
    '  name: "@cmwl1231/dsh-notify"',
    '- id: tail-plugin',
    '  config:',
    '    tail: yes',
    '',
  ].join('\n'), 'utf8');

  const persisted = writeConfig(scratch, { sound: 'silent', notifyEndKinds: ['completed'], titleCompleted: '标题: 带冒号' });
  const storeText = readFileSync(scratch, 'utf8');
  check('store writes the config block', persisted.path === scratch, JSON.stringify(persisted));
  check('store keeps the surrounding rows', storeText.includes('keep: me') && storeText.includes('tail: yes'));
  check('store keeps comments', storeText.includes('# a comment that must survive'));
  check('store writes our row', /- id: dsh-notify\n  name: "@cmwl1231\/dsh-notify"\n  config:\n    sound: silent/.test(storeText), storeText);
  check('store lists the array one item per line', storeText.includes('    notifyEndKinds:\n      - completed'));
  check('store quotes a value containing a colon', storeText.includes('titleCompleted: "标题: 带冒号"'), storeText);
  check('store leaves the next row intact', /\n- id: tail-plugin\n  config:\n    tail: yes/.test(storeText), storeText);

  // Rewriting must be idempotent: a second identical write adds no duplicate row.
  writeConfig(scratch, { sound: 'silent', notifyEndKinds: ['completed'], titleCompleted: '标题: 带冒号' });
  const twice = readFileSync(scratch, 'utf8');
  check('store does not duplicate the row', twice.split('- id: dsh-notify').length === 2, twice);
  unlinkSync(scratch);

  const rejected = await call('POST', { config: { bodySource: 'not-a-source' } });
  check('config write normalizes a bad value instead of storing it',
    rejected.ok === true && rejected.config?.bodySource === 'answer',
    JSON.stringify(rejected.config?.bodySource));
}

const failed = results.filter(result => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok || !result.detail ? '' : `  (${result.detail})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
