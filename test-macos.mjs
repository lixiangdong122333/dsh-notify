// Unit tests for the macOS delivery helpers.
//
// No notification is raised: these check the commands dsh-notify would spawn,
// including the two failure modes that matter for a shell-free spawn (a helper
// that is not installed, and text that would break the AppleScript literal).
import { findAppBundle, macToastPlan, appBundlePath, appleScriptString, resolveTerminalNotifier, MAC_SOUND } from './macos.js';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
}

// --- finding terminal-notifier ----------------------------------------------
check(
  'terminal-notifier is not found in an empty environment',
  resolveTerminalNotifier({ env: { PATH: '/nonexistent' }, exists: () => false }) === undefined,
);
check(
  'terminal-notifier is found in a Homebrew bin directory',
  resolveTerminalNotifier({ env: { PATH: '/nonexistent' }, exists: path => path === '/opt/homebrew/bin/terminal-notifier' })
    === '/opt/homebrew/bin/terminal-notifier',
);
check(
  'terminal-notifier is found through PATH as a fallback',
  resolveTerminalNotifier({ env: { PATH: '/custom/bin:/usr/bin' }, exists: path => path === '/custom/bin/terminal-notifier' })
    === '/custom/bin/terminal-notifier',
);
check(
  'a throwing exists() does not break the search',
  resolveTerminalNotifier({
    env: { PATH: '/broken:/opt/homebrew/bin' },
    exists: path => {
      if (path.startsWith('/broken')) throw new Error('denied');
      return path === '/opt/homebrew/bin/terminal-notifier';
    },
  }) === '/opt/homebrew/bin/terminal-notifier',
);

// --- the app bundle to activate ---------------------------------------------
check(
  'the packaged app bundle is derived from execPath',
  appBundlePath('/Applications/DeepSeek-Harness.app/Contents/MacOS/DeepSeek-Harness')
    === '/Applications/DeepSeek-Harness.app',
);
check(
  'a stock Electron run is not treated as the app',
  appBundlePath('/Applications/Electron.app/Contents/MacOS/Electron') === undefined,
);
check(
  'a helper process resolves to the outer app bundle',
  appBundlePath('/Applications/DeepSeek-Harness.app/Contents/Frameworks/DeepSeek-Harness Helper.app/Contents/MacOS/DeepSeek-Harness Helper')
    === '/Applications/DeepSeek-Harness.app',
);
check('a plain node execPath has no bundle', appBundlePath('/usr/local/bin/node') === undefined);

// --- finding the app bundle --------------------------------------------------
check(
  'the executable path wins when it names the app',
  findAppBundle({
    execPath: '/Applications/DeepSeek-Harness.app/Contents/MacOS/DeepSeek-Harness',
    dirs: ['/unused'],
    readdir: () => ['DeepSeek-Other.app'],
  }) === '/Applications/DeepSeek-Harness.app',
);
check(
  'a CLI host falls back to scanning the Applications folder',
  findAppBundle({
    execPath: '/usr/local/bin/node',
    dirs: ['/Applications'],
    readdir: path => (path === '/Applications' ? ['Safari.app', 'DeepSeek-Harness.app'] : []),
    exists: path => path === '/Applications/DeepSeek-Harness.app',
  }) === '/Applications/DeepSeek-Harness.app',
);
check(
  'an unreadable Applications folder is not fatal',
  findAppBundle({
    execPath: '/usr/local/bin/node',
    dirs: ['/Applications'],
    readdir: () => {
      throw new Error('denied');
    },
  }) === undefined,
);
check(
  'no matching app means no click action',
  findAppBundle({ execPath: '/usr/local/bin/node', dirs: [], readdir: () => [] }) === undefined,
);

// --- AppleScript escaping ----------------------------------------------------
check('quotes are escaped in AppleScript literals',
  appleScriptString('say "hi"') === '"say \\"hi\\""', appleScriptString('say "hi"'));
check('backslashes are escaped in AppleScript literals',
  appleScriptString('a\\b') === '"a\\\\b"', appleScriptString('a\\b'));

// --- the osascript plan ------------------------------------------------------
const viaScript = macToastPlan({
  backend: 'osascript',
  title: 'DSH · 任务完成',
  body: '已经完成了。',
  sound: 'default',
});
check('osascript is the command', viaScript.command === 'osascript', viaScript.command);
check('osascript runs one -e script', viaScript.args?.[0] === '-e' && viaScript.args.length === 2, JSON.stringify(viaScript.args));
check('the script carries the notification title and body',
  viaScript.args[1].includes('display notification "已经完成了。"')
  && viaScript.args[1].includes('with title "DSH · 任务完成"'),
  viaScript.args[1]);
check('the script asks for the macOS sound', viaScript.args[1].includes(`sound name "${MAC_SOUND}"`), viaScript.args[1]);

const silent = macToastPlan({ backend: 'osascript', title: 't', body: 'b', sound: 'silent' });
check('a silent toast omits the sound', !silent.args[1].includes('sound name'), silent.args[1]);

const quoted = macToastPlan({ backend: 'osascript', title: 'say "x"', body: 'back\\slash', sound: 'silent' });
check('a quoted title survives as an escaped literal',
  quoted.args[1].includes('with title "say \\"x\\""'), quoted.args[1]);
check('a backslash survives as an escaped literal',
  quoted.args[1].includes('display notification "back\\\\slash"'), quoted.args[1]);

// --- the terminal-notifier plan ---------------------------------------------
const viaHelper = macToastPlan({
  backend: 'terminal-notifier',
  title: 'DSH · 任务完成',
  body: '已经完成了。',
  sound: 'default',
  app: '/Applications/DeepSeek-Harness.app',
});
check('terminal-notifier is the command', viaHelper.command === 'terminal-notifier', viaHelper.command);
check('terminal-notifier receives title and message',
  viaHelper.args.includes('-title') && viaHelper.args.includes('-message')
  && viaHelper.args.includes('DSH · 任务完成') && viaHelper.args.includes('已经完成了。'),
  JSON.stringify(viaHelper.args));
check('terminal-notifier receives the sound',
  viaHelper.args.includes('-sound') && viaHelper.args.includes(MAC_SOUND), JSON.stringify(viaHelper.args));
check('a click reopens the app through the shell',
  (() => {
    const index = viaHelper.args.indexOf('-execute');
    return index >= 0 && viaHelper.args[index + 1] === "open -a '/Applications/DeepSeek-Harness.app'";
  })(), JSON.stringify(viaHelper.args));

const noApp = macToastPlan({ backend: 'terminal-notifier', title: 't', body: 'b', sound: 'silent' });
check('no app path means no click action', !noApp.args.includes('-execute'), JSON.stringify(noApp.args));
check('a silent terminal-notifier toast omits the sound', !noApp.args.includes('-sound'), JSON.stringify(noApp.args));
check('the message flag is always present for terminal-notifier',
  noApp.args.includes('-message'), JSON.stringify(noApp.args));

// --- report ------------------------------------------------------------------
const failed = results.filter(result => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok || !result.detail ? '' : `  (${result.detail})`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
