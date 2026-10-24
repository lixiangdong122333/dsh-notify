// Persist this plugin's settings into the profile patch.
//
// The settings page edits the same `config:` block a hand edit would touch, so
// the profile's cordis.patch.yml stays the one source of truth. The file is
// hand-maintained YAML full of comments and other plugins' rows, so it is edited
// textually: locate this row, replace only the lines of its `config:` mapping,
// and leave every other byte alone. That is deliberately narrower than a
// parse-and-reserialize round trip, which would drop comments and reflow values.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The YAML scalar spelling of one setting value. */
function scalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  // Quote when the value could otherwise parse as something else or when it
  // holds a character YAML treats specially at the start of a scalar.
  if (text === '' || /^[\s'"#&*!|>%@`{[\-?:]/.test(text) || /:\s|\s#|^\d|^(true|false|null|~)$/i.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

/** Render the `config:` block for this row at the given indentation. */
function block(config, indent) {
  const pad = ' '.repeat(indent);
  const lines = [`${pad}config:`];
  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}  ${key}: []`);
        continue;
      }
      lines.push(`${pad}  ${key}:`);
      for (const item of value) lines.push(`${pad}    - ${scalar(item)}`);
      continue;
    }
    lines.push(`${pad}  ${key}: ${scalar(value)}`);
  }
  return lines;
}

/**
 * Find the profile patch this plugin's settings belong in.
 *
 * The plugin ships its own `cordis.patch.yml` (the defaults an install starts
 * from), so a plain "first file that mentions us" search would pick the wrong
 * one and write settings the Host never reads. The profile is therefore derived
 * from where the package is installed — `<profile>/node_modules/<name>` — and
 * `DSH_PROFILE_DIR` only ever narrows that down.
 *
 * A profile patch that already declares the plugin wins. When none does, the
 * install-derived profile patch is still returned so the first save can add the
 * row there; that is the file the Host reads, and it is why the settings page is
 * writable on a normal install instead of read-only. A run from a checkout
 * (`DSH_PROFILE_DIR` pointing somewhere else, no patch next to the package)
 * still resolves to null and stays read-only.
 * @param {string} here the plugin's own directory
 * @returns {string | null} the profile patch path, or null when there is none
 */
export function findPatch(here) {
  // `<profile>/node_modules/@scope/name` -> `<profile>`: the scope adds a level,
  // so it is four steps up, not three.
  const fromInstall = join(here, '..', '..', '..');
  const installed = join(fromInstall, 'cordis.patch.yml');
  const envDir = process.env.DSH_PROFILE_DIR;
  const envPatch = envDir === undefined ? undefined : join(envDir, 'cordis.patch.yml');

  const candidates = [envPatch, installed].filter(path => typeof path === 'string');
  let fallback = null;
  for (const path of candidates) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // Missing or unreadable candidate: try the next one.
      continue;
    }
    if (locateRow(text) !== null) return path;
    // The install-derived patch is the profile that hosts this package, so it is
    // the right place to add the row. `DSH_PROFILE_DIR` may name a different
    // profile (a checkout run), and writing there would be wrong.
    if (path === installed) fallback = path;
  }
  return fallback;
}

/**
 * Locate this plugin's row inside a patch document.
 * @param {string} text the patch file contents
 * @returns {{ start: number, end: number, indent: number } | null}
 */
function locateRow(text) {
  const lines = text.split('\n');
  const rowIndex = lines.findIndex(line => /^\s*-\s+id:\s*dsh-notify\s*$/.test(line));
  if (rowIndex < 0) return null;

  const rowIndent = lines[rowIndex].length - lines[rowIndex].trimStart().length;
  const keyIndent = rowIndent + 2;
  // The row ends at the next entry at the same or a lower indentation.
  let end = lines.length;
  for (let index = rowIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= rowIndent && /^\s*-/.test(line)) { end = index; break; }
  }

  return { start: rowIndex + 1, end, indent: keyIndent };
}

/**
 * Rewrite this plugin's `config:` block, keeping every other line as it was.
 * @param {string} path the profile patch file
 * @param {object} config the settings to persist
 * @returns {{ path: string } | { error: string }}
 */
export function writeConfig(path, config) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { error: `cannot read ${path}: ${String(error)}` };
  }

  const row = locateRow(text);
  if (row === null) {
    // The profile patch does not declare the plugin yet (its defaults come from
    // the bundle's own patch). Add the row once; every later save edits it in
    // place, so a hand edit and the settings page keep writing the same block.
    const added = [
      '- id: dsh-notify',
      '  name: "@cmwl1231/dsh-notify"',
      ...block(config, 2),
      '',
    ];
    const prefix = text.trim() === '' ? '' : `${text.replace(/\s*$/u, '')}\n\n`;
    try {
      writeFileSync(path, `${prefix}${added.join('\n')}`, 'utf8');
    } catch (error) {
      return { error: `cannot write ${path}: ${String(error)}` };
    }
    return { path, created: true };
  }

  const lines = text.split('\n');
  // Replace an existing config mapping in place, or insert one after the row's
  // `name:` line when the row carries no settings yet.
  const configAt = lines.findIndex((line, index) => index >= row.start && index < row.end
    && new RegExp(`^\\s{${row.indent}}config:\\s*$`).test(line));

  const rendered = block(config, row.indent);
  if (configAt >= 0) {
    let configEnd = row.end;
    for (let index = configAt + 1; index < row.end; index += 1) {
      const line = lines[index];
      if (line.trim() === '') continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= row.indent) { configEnd = index; break; }
    }
    lines.splice(configAt, configEnd - configAt, ...rendered);
  } else {
    const nameAt = lines.findIndex((line, index) => index >= row.start && index < row.end && /^\s*name:/.test(line));
    const insertAt = nameAt < 0 ? row.start : nameAt + 1;
    lines.splice(insertAt, 0, ...rendered);
  }

  try {
    writeFileSync(path, lines.join('\n'), 'utf8');
  } catch (error) {
    return { error: `cannot write ${path}: ${String(error)}` };
  }
  return { path };
}
