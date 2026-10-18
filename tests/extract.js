#!/usr/bin/env node
/* visualise — shared test helper.

   The page is a single file, so the tests do not import it: they pull the real
   functions out of index.html by brace matching. That way a test can never be
   passing against a copy of the code that the browser no longer runs.

   The matcher tracks strings, template literals and regex literals so that
   braces inside them are not counted. Deciding whether a `/` opens a regex or
   is a division needs the previous token: after a keyword (`return`, `case`,
   `typeof`, …) or after an operator it is a regex, after an identifier, number,
   `)` or `]` it is division. */

'use strict';
const fs = require('fs');
const path = require('path');

const KEYS = ['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'new',
              'delete', 'void', 'instanceof', 'yield', 'await', 'throw'];
const PRE_OP = '=(,;:!&|?+*%<>[{~^';

function readSource() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
  if (!m) throw new Error('could not find the main script block in index.html');
  return m[1];
}

/* the word immediately before position i, ignoring spaces */
function wordBefore(source, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(source[j])) j--;
  if (j < 0) return { word: '', char: '' };
  const char = source[j];
  const end = j + 1;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(source[j])) j--;
  return { word: source.slice(j + 1, end), char };
}

function opensRegex(source, i) {
  const { word, char } = wordBefore(source, i);
  if (char === '') return true;
  if (PRE_OP.indexOf(char) !== -1) return true;
  return KEYS.indexOf(word) !== -1;
}

/* Extract a top-level `  function name(...) { ... }` from the page source. */
function extract(source, name) {
  const needle = '\n  function ' + name + '(';
  const start = source.indexOf(needle);
  if (start === -1) throw new Error('function not found in index.html: ' + name);
  const from = start + 1;
  const open = source.indexOf('{', source.indexOf('(', from));
  let depth = 0, i = open, inStr = null, inRe = false;
  for (; i < source.length; i++) {
    const c = source[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (inRe) {
      if (c === '\\') { i++; continue; }
      if (c === '/') inRe = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/') {
      // Comments first: a '/' followed by another '/' or '*' opens one, and
      // must not be mistaken for the start of a regex (that was a real bug:
      // it swallowed the rest of the function).
      const next = source[i + 1];
      if (next === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
      if (next === '*') { while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++; i++; continue; }
      if (opensRegex(source, i)) { inRe = true; continue; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('unbalanced braces extracting: ' + name);
  return source.slice(from, i);
}

/* Build a sandbox holding the named functions, plus any preamble the caller
   needs (e.g. an array the function closes over). */
function sandbox(source, names, preamble) {
  const body = names.map((n) => extract(source, n)).join('\n');
  const fn = new Function((preamble || '') + '\n' + body + '\nreturn {' + names.join(',') + '};');
  return fn();
}

module.exports = { readSource, extract, sandbox };
