// Windows toast notifications for DeepSeek Harness.
//
// Two moments raise a toast:
//   * a turn ends (the task finished, failed, or stopped), observed on the
//     committed `turn/end` event of that session's log; and
//   * the agent asks the user something (`ask_user_question`, which includes
//     plan approval) and the request is still pending after a short delay.
//
// notify.ps1 raises the toast through WinRT as the DSH Start Menu shortcut, so
// Windows shows the application's own icon. Clicking it runs `dsh://notify`,
// which the desktop shell already handles by focusing, restoring, or recreating
// its primary window.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config, normalize } from './schema.js';
import { findPatch, writeConfig } from './settings-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'notify.ps1');
const PROTOCOL = 'dsh://notify';
const MAX_TITLE = 60;
const FOCUS_STALE_MS = 15000;
const FOCUS_PATH = '/dsh-notify-focus.js';

export const name = 'dsh-notify';
export const inject = ['agents', 'webServer'];
export { Config };

export function apply(ctx, config = {}) {
  const logger = ctx.logger;
  // Two guards decide whether this plugin runs at all: the platform, and the
  // app's Start Menu shortcut. Both are exactly right for a real install and
  // both make the plugin a no-op on a test runner, which has neither Windows nor
  // DeepSeek-Harness. DSH_NOTIFY_TEST_MODE exists so the suite can exercise the
  // plugin instead of its guards; nothing sets it outside the tests.
  const testMode = process.env.DSH_NOTIFY_TEST_MODE === '1';
  if (process.platform !== 'win32' && !testMode) return;

  const options = normalize(config);
  const clipBody = text => clip(text, options.bodyLength);

  const shortcut = findShortcut();
  if (shortcut === undefined && !testMode) {
    logger?.warn?.('dsh-notify: the DeepSeek Harness Start Menu shortcut is missing; notifications stay off');
    return;
  }

  const log = (stage, detail = {}) => logger?.debug?.(`dsh-notify: ${stage} ${JSON.stringify(detail)}`);
  const warn = (stage, detail = {}) => logger?.warn?.(`dsh-notify: ${stage} ${JSON.stringify(detail)}`);

  /** Per-session turn bookkeeping; nothing here is persisted. */
  const turns = new Map();
  /** Sessions with a turn in flight, so a finished one can spot the others. */
  const running = new Set();
  /** Question timers keyed by session id. */
  const questions = new Map();
  /** Focus heartbeats from browser tabs: an opaque tab label -> last report. */
  const focusReports = new Map();

  // ---- focus ---------------------------------------------------------------

  // The renderer reports whether one of its tabs is the foreground tab of a
  // visible window. Only that report is trustworthy: a host-side window check
  // cannot tell "in front" from "behind another app", and notifications exist
  // precisely for the case where DSH is behind something else. A page that
  // never reports simply never suppresses a toast.
  function clientFocused() {
    const now = Date.now();
    for (const [label, seen] of focusReports) {
      if (now - seen > FOCUS_STALE_MS) focusReports.delete(label);
    }
    return focusReports.size > 0;
  }

  if (options.skipWhenFocused) {
    ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script-src', placement: 'body', src: FOCUS_PATH });
    }), 'dsh-notify:focus-inject');
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: FOCUS_PATH,
      handler: (_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(focusScript());
      },
    }), 'dsh-notify:focus-script');
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-notify/focus',
      handler: (req, res) => {
        try {
          const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
          const now = Date.now();
          for (const label of (params.get('on') ?? '').split(',')) {
            if (label) focusReports.set(label, now);
          }
          for (const label of (params.get('off') ?? '').split(',')) {
            if (label) focusReports.delete(label);
          }
          res.writeHead(204, { 'Cache-Control': 'no-store' });
        } catch (error) {
          log('focus-report-failed', { error: String(error) });
          res.writeHead(400);
        }
        res.end();
      },
    }), 'dsh-notify:focus-report');
  }

  // ---- notifications -------------------------------------------------------

  function notify(title, body, sound = soundFor('turn')) {
    const text = clipBody(body);
    // Windows PowerShell drops an empty `-File` argument, so an empty body is
    // sent as "no -Body at all" rather than as a zero-length value: the script
    // defaults it to '' and renders a title-only toast.
    const args = [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT,
      '-Mode', 'send',
      '-Title', clip(title, MAX_TITLE),
    ];
    if (text) args.push('-Body', text);
    args.push('-Sound', sound, '-Activate', PROTOCOL);
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => warn('toast-spawn-failed', { error: String(error) }));
    child.on('exit', (code) => {
      if (code === 0) log('toast', { title, body });
      else warn('toast-failed', { code, output: output.trim().slice(0, 400) });
    });
    child.unref?.();
  }

  /**
   * Resolve the sound flag for one toast: 'default', 'silent', or 'important'.
   * `important` silences ordinary turn endings and keeps only the question
   * toast audible, which is the usual way to stay reachable without noise.
   */
  function soundFor(kind) {
    if (options.sound === 'silent') return 'silent';
    if (options.sound === 'important') return kind === 'question' ? 'default' : 'silent';
    return 'default';
  }

  // ---- turns ---------------------------------------------------------------

  // `session/event` is an unscoped post-commit feed: this listener sees every
  // live session and filters by identity, the same pattern the agent loop uses.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      onSessionEvent(session, event);
    } catch (error) {
      log('session-event-failed', { error: String(error) });
    }
  }), 'dsh-notify:session-events');

  ctx.on('agent/created', ({ agent }) => {
    const session = agent?.session;
    if (session === undefined) return;
    if (session.header?.origin === 'subagent') return;
    turns.set(session.id, { startedAt: undefined });
    if (agent.status === 'running') running.add(session.id);
  });

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id;
    if (sessionId === undefined) return;
    turns.delete(sessionId);
    running.delete(sessionId);
    clearQuestion(sessionId);
  });

  function onSessionEvent(session, event) {
    const turn = turns.get(session?.id);
    if (turn === undefined) return;

    if (event.type === 'turn/start') {
      turn.startedAt = event.time;
      running.add(session.id);
      return;
    }
    if (event.type === 'tool/result') {
      // Any tool result settles the question this toast announced.
      clearQuestion(session.id);
      return;
    }
    if (event.type !== 'turn/end') return;

    running.delete(session.id);
    clearQuestion(session.id);
    const elapsed = turn.startedAt === undefined ? 0 : Date.now() - turn.startedAt;
    turn.startedAt = undefined;
    if (!options.onTurnEnd || elapsed < options.minTurnMs) return;

    const kind = event.data?.reason?.kind ?? 'completed';
    // Which endings are worth a toast is the user's choice. `forked` and
    // `interrupted` are handovers inside the app, never a finished task, so
    // they are not offered as choices at all.
    if (!options.notifyEndKinds.has(kind)) return;
    // `anyOtherRunning` is only consulted when the setting asks for it: a toast
    // for a finished task while another session still works interrupts mid-flow.
    if (options.skipWhenFocused && clientFocused() && !anyOtherRunning(session.id)) return;
    if (options.skipWhenOthersRunning && anyOtherRunning(session.id)) return;

    notify(
      kind === 'completed' ? options.titleCompleted : options.titleEnded,
      turnBody(session),
      soundFor('turn'),
    );
  }

  /** Build the turn-end body from the configured source. */
  function turnBody(session) {
    if (options.bodySource === 'none') return '';
    const text = options.bodySource === 'prompt'
      ? lastPrompt(session) || lastAnswer(session)
      : lastAnswer(session) || lastPrompt(session);
    return text || '回到 DeepSeek-Harness 查看结果';
  }

  function anyOtherRunning(sessionId) {
    for (const id of running) {
      if (id !== sessionId) return true;
    }
    return false;
  }

  function clearQuestion(sessionId) {
    const timer = questions.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    questions.delete(sessionId);
  }

  // ---- questions -----------------------------------------------------------

  // While a question is pending the agent is blocked, so this listener holds
  // the waterfall open and rings when nobody answered by the deadline. It
  // raises a toast and never answers: the shipped Web answerer stays the only
  // responder, so answering in this window would be ambiguous. Once the delay
  // elapses the listener steps aside, which lets that answerer take the request
  // as usual; by then the toast is up and the user is on their way back.
  ctx.on('user-questions/request', (request, next) => {
    const agent = request?.agent;
    if (!options.notifyQuestions || agent === undefined) return next();
    const session = agent.session;
    if (session === undefined) return next();
    if (options.skipWhenFocused && clientFocused()) return next();
    if (options.skipWhenOthersRunning && anyOtherRunning(session.id)) return next();
    // A plan review is the one question with its own approval UI intent; it is
    // answered on screen, so a toast would arrive too late to help.
    if (!options.notifyPlanReviews && request.questions?.some(question => question?.intent?.kind === 'plan-review')) return next();
    const body = questionSummary(request.questions);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        questions.delete(session.id);
        if (!request.signal?.aborted) notify(options.titleQuestion, body, soundFor('question'));
        resolve(next());
      }, options.questionDelayMs);
      timer.unref?.();
      questions.set(session.id, timer);
    });
  });

  // ---- settings page support -----------------------------------------------

  // The settings page asks the Host for a test toast, because the Host owns the
  // PowerShell helper, the shortcut lookup and the AUMID entry. Doing it here
  // also means the page reports the real outcome instead of optimistically
  // claiming success.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/test',
    handler: (_req, res) => {
      const reply = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      try {
        const child = spawn('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', SCRIPT,
          '-Mode', 'send',
          '-Title', clip(options.titleCompleted, MAX_TITLE),
          '-Body', clipBody('这是一条测试通知，设置页已生效。'),
          '-Sound', soundFor('turn'),
          '-Activate', PROTOCOL,
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout?.on('data', (chunk) => { output += chunk; });
        child.stderr?.on('data', (chunk) => { output += chunk; });
        child.on('error', (error) => reply(500, { ok: false, detail: String(error) }));
        child.on('exit', (code) => {
          if (child.exitCode === null) return;
          if (code === 0) {
            log('test-toast', {});
            reply(200, { ok: true });
          } else {
            warn('test-toast-failed', { code, output: output.trim().slice(0, 400) });
            reply(200, { ok: false, detail: output.trim().slice(0, 300) || `exit ${code}` });
          }
        });
      } catch (error) {
        reply(500, { ok: false, detail: String(error) });
      }
    },
  }), 'dsh-notify:test-route');

  // Read and write this plugin's settings.
  //
  // The shipped settings form (`configForms`) is an internal Client service a
  // third-party bundle cannot inject, so the page talks to these routes instead.
  // The values live in this profile's cordis.patch.yml; a write here edits the
  // very block a hand edit would, so there is still one source of truth, and it
  // also updates the live options so the change applies without a restart.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/config',
    handler: (req, res) => {
      // Resolved per request: the profile may move or be recreated under a long
      // running Host, and a stale path would silently stop persisting.
      const patch = findPatch(HERE);
      const reply = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
      };

      const current = () => ({
        ...options,
        notifyEndKinds: [...options.notifyEndKinds],
      });

      if (req.method === 'GET') {
        reply(200, { ok: true, writable: patch !== null, config: current(), patch });
        return;
      }
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
          try {
            const incoming = JSON.parse(raw || '{}').config ?? {};
            // Reuse the startup normalizer so a value written here can never be
            // one the plugin would reject on the next boot.
            const next = normalize(incoming);
            Object.assign(options, next);
            // Persist the raw shape (a list, not a Set) or a restart would read
            // back something the schema never saw.
            const persisted = patch === null
              ? { error: 'this plugin is not declared in a profile patch' }
              : writeConfig(patch, settingsSnapshot(next));
            reply(200, { ok: true, config: current(), persisted });
          } catch (error) {
            reply(200, { ok: false, detail: String(error) });
          }
        });
        return;
      }
      reply(405, { ok: false, detail: 'method not allowed' });
    },
  }), 'dsh-notify:config-route');

  // ---- reading the transcript ---------------------------------------------

  return {
    /** Raise one toast exactly as the plugin does; useful for a manual check. */
    notify,
    /** Resolved settings, so the settings page can show what is in effect. */
    settings: settingsSnapshot,
  };
}

/**
 * The settings in their serializable shape: the live `options` keep a Set for
 * the ending kinds, which neither JSON nor the YAML writer should see.
 * @param {object} options the normalized settings
 * @returns {object} a plain object
 */
function settingsSnapshot(options) {
  return { ...options, notifyEndKinds: [...options.notifyEndKinds] };
}

// ---- helpers ---------------------------------------------------------------

function questionSummary(questions) {
  const first = Array.isArray(questions) ? questions[0] : undefined;
  if (first === undefined) return '回到 DeepSeek Harness 继续';
  const head = typeof first.header === 'string' && first.header.trim() ? `${first.header.trim()}：` : '';
  const text = typeof first.question === 'string' ? first.question : '';
  return `${head}${text}`.trim() || '回到 DeepSeek Harness 继续';
}

function lastPrompt(session) {
  try {
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue;
      const text = textOf(event.data.content);
      if (text) return text;
    }
  } catch {
    // A log that cannot be snapshotted simply contributes no text.
  }
  return '';
}

function lastAnswer(session) {
  try {
    const events = session.snapshotEvents();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type !== 'assistant/message') continue;
      const text = textOf(event.data?.message?.content);
      if (text) return text;
    }
  } catch {
    // Fall back to the prompt-based body.
  }
  return '';
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join(' ')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/[#>*_`]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim();
}

function clip(text, max) {
  const value = oneLine(text);
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function findShortcut() {
  const candidates = [
    join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness.lnk'),
    join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness.lnk'),
  ];
  return candidates.find(candidate => existsSync(candidate));
}

/** The heartbeat the Web page runs while one of its tabs is visible and focused. */
function focusScript() {
  return `;(function () {
  if (window.__dshNotifyFocus) return;
  window.__dshNotifyFocus = true;
  var endpoint = '/dsh-notify/focus';
  var label = (window.__dshNotifyTab || (window.__dshNotifyTab = String(Math.random()).slice(2))) + '@' + location.pathname;
  var timer = 0;
  function watch() { return document.visibilityState === 'visible' && document.hasFocus(); }
  function report() { fetch(endpoint + '?on=' + encodeURIComponent(label), { cache: 'no-store' }).catch(function () {}); }
  function leave() { fetch(endpoint + '?off=' + encodeURIComponent(label), { cache: 'no-store', keepalive: true }).catch(function () {}); }
  function sync() {
    clearInterval(timer);
    if (watch()) { report(); timer = setInterval(report, 2000); }
    else leave();
  }
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('focus', sync);
  window.addEventListener('blur', sync);
  window.addEventListener('beforeunload', leave);
  sync();
})();`;
}
