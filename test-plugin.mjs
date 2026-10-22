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

const { apply, inject } = await import('./index.js');

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

// --- cwd scoping ------------------------------------------------------------
spawned.length = 0;
const scoped = makeContext();
apply(scoped, { skipWhenFocused: false, cwd: 'C:\\work' });
const outside = makeSession({ id: 'session-out', cwd: 'D:\\other' });
scoped.emit('agent/created', { agent: { id: 'session-out', session: outside, status: 'idle' } });
scoped.emit('session/event', outside, { type: 'turn/start', time: Date.now() });
scoped.emit('session/event', outside, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } });
await new Promise(resolve => setTimeout(resolve, 30));
check('cwd scope excludes other workspaces', spawned.length === 0, `spawned=${spawned.length}`);

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

const failed = results.filter(result => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok || !result.detail ? '' : `  (${result.detail})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
