// macOS notification delivery for dsh-notify.
//
// Two channels, best first:
//
//   * `terminal-notifier` — an optional helper (`brew install
//     terminal-notifier`). It appears under its own name in System Settings,
//     and `-execute` runs a command on click, which is how a toast can bring
//     DeepSeek-Harness back to the front.
//   * `osascript` — always present. `display notification` posts through Script
//     Editor; clicking a Script Editor notification cannot reach DSH, so this
//     is the fallback that still notifies but without a way back.
//
// Both are ordinary processes spawned by the Host, exactly like `notify.ps1` on
// Windows, so the plugin keeps working without a native Node dependency.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Homebrew's shims, checked before PATH because a GUI app often has neither. */
const HOMEBREW_BIN = ['/opt/homebrew/bin', '/usr/local/bin'];

/** The macOS sound both channels use for an audible toast. */
export const MAC_SOUND = 'Glass';

/**
 * Find `terminal-notifier` without trusting the spawning process's PATH: a GUI
 * app is launched by launchd with a minimal environment, so Homebrew's bin
 * directories are probed directly before PATH is consulted.
 * @param {{ env?: NodeJS.ProcessEnv, exists?: (path: string) => boolean }} [input]
 * @returns {string | undefined} the executable path, or undefined when absent
 */
export function resolveTerminalNotifier({ env = process.env, exists = existsSync } = {}) {
  const dirs = [...HOMEBREW_BIN, ...(env.PATH ?? '').split(delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, 'terminal-notifier');
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // An unreadable directory just cannot answer; try the next one.
    }
  }
  return undefined;
}

/**
 * The DeepSeek-Harness `.app` bundle this Host runs from, when it can be
 * derived from the executable path. A stock Electron dev run would resolve to
 * `Electron.app`, which is not the app to bring back, so only a bundle whose
 * name says DeepSeek is accepted.
 * @param {string} execPath defaults to `process.execPath`
 * @returns {string | undefined}
 */
export function appBundlePath(execPath = process.execPath) {
  const path = String(execPath);
  // The first `.app` in the path is the outer application. A helper process
  // runs from `<app>.app/Contents/Frameworks/<name> Helper.app/...`, and
  // opening the helper instead of the app would be wrong, so the first match
  // is deliberate rather than the last.
  const index = path.indexOf('.app/');
  if (index < 0) return undefined;
  const bundle = path.slice(0, index + 4);
  const name = bundle.slice(bundle.lastIndexOf('/') + 1, -4);
  // A stock Electron dev run resolves to Electron.app, which is not the app to
  // bring back.
  return /deepseek/iu.test(name) ? bundle : undefined;
}

/**
 * Locate the DeepSeek-Harness app bundle a click should reopen.
 *
 * The executable path answers this for the packaged desktop app. A Host started
 * from a CLI (`dsh web`) runs from a plain node binary instead, so the usual
 * install locations are scanned for an app whose name says DeepSeek.
 * @param {{ execPath?: string, dirs?: string[], readdir?: (path: string) => string[], exists?: (path: string) => boolean }} [input]
 * @returns {string | undefined}
 */
export function findAppBundle({ execPath = process.execPath, dirs, readdir = readdirSync, exists = existsSync } = {}) {
  const derived = appBundlePath(execPath);
  if (derived !== undefined) return derived;

  const search = dirs ?? ['/Applications', join(homedir(), 'Applications')];
  for (const dir of search) {
    let entries;
    try {
      entries = readdir(dir);
    } catch {
      continue;
    }
    const match = entries.find(name => /^deepseek.*\.app$/iu.test(name));
    if (match === undefined) continue;
    const candidate = join(dir, match);
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // Unreadable candidate: keep looking.
    }
  }
  return undefined;
}

/** Quote one argument for `/bin/sh -c`, which is how `-execute` runs. */
function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

/**
 * The AppleScript string literal for one value. The toast text is clipped to
 * one line before it gets here, so only quote and backslash need escaping.
 * @param {string} value
 * @returns {string}
 */
export function appleScriptString(value) {
  return `"${String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

/**
 * Build the command that raises one toast.
 *
 * `sound` is already resolved by the caller: `silent` omits the sound flag,
 * anything else uses {@link MAC_SOUND}.
 * @param {{ backend?: 'terminal-notifier' | 'osascript', title: string, body: string, sound?: 'default' | 'silent', app?: string }} input
 * @returns {{ command: string, args: string[] }}
 */
export function macToastPlan({ backend, title, body, sound = 'default', app }) {
  if (backend === 'terminal-notifier') {
    // `-message` is required by the helper even when only a title is wanted.
    const args = ['-title', String(title), '-message', String(body ?? '')];
    if (sound !== 'silent') args.push('-sound', MAC_SOUND);
    // A click runs through the shell, so `open -a` also activates a running app.
    if (app) args.push('-execute', `open -a ${shellQuote(app)}`);
    return { command: 'terminal-notifier', args };
  }
  const script = [
    `display notification ${appleScriptString(body ?? '')}`,
    `with title ${appleScriptString(title)}`,
  ];
  if (sound !== 'silent') script.push(`sound name ${appleScriptString(MAC_SOUND)}`);
  return { command: 'osascript', args: ['-e', script.join(' ')] };
}
