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
 * Find the patch file that declares this plugin.
 * @param {string} here the plugin's own directory
 * @returns {string | null} the profile patch path, or null when nothing declares us
 */
export function findPatch(here) {
  const profileDir = process.env.DSH_PROFILE_DIR;
  const candidates = [
    profileDir === undefined ? undefined : join(profileDir, 'cordis.patch.yml'),
    join(here, '..', '..', 'cordis.patch.yml'),
    join(here, '..', 'cordis.patch.yml'),
    join(here, 'cordis.patch.yml'),
  ].filter(path => typeof path === 'string');

  for (const path of candidates) {
    try {
      const text = readFileSync(path, 'utf8');
      const row = locateRow(text);
      if (row !== null) return path;
    } catch {
      // Missing or unreadable candidate: try the next one.
    }
  }
  return null;
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
  if (row === null) return { error: `no dsh-notify row in ${path}` };

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
