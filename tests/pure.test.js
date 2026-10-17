#!/usr/bin/env node
/* visualise — pure-function test harness.
   Extracts functions from index.html by brace matching (no browser needed). */
'use strict';
const fs = require('fs');

const html = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
if (!m) { console.error('FAIL: could not find main script block'); process.exit(1); }
const source = m[1];

/* --- extract a top-level `  function name(...) { ... }` by brace matching --- */
function extract(name) {
  const needle = '\n  function ' + name + '(';
  const start = source.indexOf(needle);
  if (start === -1) throw new Error('function not found: ' + name);
  const from = start + 1;
  const open = source.indexOf('{', source.indexOf('(', from));
  let depth = 0, i = open, inStr = null, inRe = false;
  for (; i < source.length; i++) {
    const c = source[i], prev = source[i - 1];
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
    if (c === '/' && '=(,;:!&|?+*%<>[{'.includes(prev)) { inRe = true; continue; }
    if (c === '/' && prev === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(from, i);
}

const names = ['hexToRgb', 'parseName', 'fmt', 'bandValue', 'pickRelease', 'pickMatch',
               'haveArtistQuery', 'srgbLum', 'contrast', 'mixRgb', 'coverInk', 'colourStr', 'parseColour'];
const preamble = 'var BAR_COUNT = 48;\nvar bins = new Uint8Array(1024);\n';
const body = names.map(extract).join('\n');
const sandbox = new Function(preamble + body + '\nreturn {' + names.join(',') + '};');
const F = sandbox();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps); }

console.log('\n--- colour helpers ---');
ok(F.hexToRgb('#3b6ea5') === '59,110,165', 'hexToRgb full hex', F.hexToRgb('#3b6ea5'));
ok(F.hexToRgb('#fff') === '255,255,255', 'hexToRgb short hex', F.hexToRgb('#fff'));
ok(F.hexToRgb('garbage') === '59,110,165', 'hexToRgb falls back to accent', F.hexToRgb('garbage'));
ok(JSON.stringify(F.parseColour('#faf9f7')) === '[250,249,247]', 'parseColour hex');
ok(JSON.stringify(F.parseColour('rgb(22, 22, 26)')) === '[22,22,26]', 'parseColour rgb()');
ok(F.parseColour('') === null, 'parseColour empty → null');
ok(F.colourStr([1.4, 2.6, 3.5]) === 'rgb(1,3,4)', 'colourStr rounds', F.colourStr([1.4, 2.6, 3.5]));

console.log('\n--- filename parsing (file-drop fallback) ---');
ok(JSON.stringify(F.parseName('Boards of Canada - Roygbiv.mp3')) ===
   JSON.stringify({ artist: 'Boards of Canada', title: 'Roygbiv' }), 'Artist - Title.ext');
ok(JSON.stringify(F.parseName('roygbiv.flac')) ===
   JSON.stringify({ artist: 'Local file', title: 'roygbiv' }), 'bare filename');

console.log('\n--- time formatting ---');
ok(F.fmt(0) === '0:00', 'zero');
ok(F.fmt(65.9) === '1:05', 'minutes + padded seconds', F.fmt(65.9));
ok(F.fmt(599) === '9:59', 'nine fifty-nine');
ok(F.fmt(-1) === '0:00' && F.fmt(NaN) === '0:00' && F.fmt(Infinity) === '0:00', 'invalid input');

console.log('\n--- FFT banding ---');
F.bins === undefined; // bandValue closes over `bins` from the preamble
const sandbox2 = new Function(preamble + body + '\nbins[0] = 255; return bandValue(0, 1024);');
ok(near(sandbox2(), 1), 'band 0 reads bin 0 (regression: used to skip it)', sandbox2());
const sandbox3 = new Function(preamble + body + '\nbins[1023] = 255; return bandValue(47, 1024);');
ok(sandbox3() > 0.9, 'top band reaches the last bin', sandbox3());

console.log('\n--- contrast engine (WCAG sweep) ---');
console.log('  luminance: black=' + F.srgbLum([0, 0, 0]).toFixed(4) +
            ' white=' + F.srgbLum([255, 255, 255]).toFixed(4) +
            ' #3b6ea5=' + F.srgbLum([59, 110, 165]).toFixed(4));
ok(near(F.srgbLum([255, 255, 255]), 1, 1e-6), 'white luminance = 1');
ok(near(F.srgbLum([0, 0, 0]), 0, 1e-6), 'black luminance = 0');
ok(near(F.contrast([0, 0, 0], [255, 255, 255]), 21, 1e-6), 'black/white contrast = 21');

const covers = {
  'white': [255, 255, 255], 'black': [0, 0, 0], 'red': [231, 76, 60],
  'yellow': [241, 196, 15], 'gold': [255, 215, 0], 'blue': [52, 152, 219],
  'navy': [0, 17, 34], 'green': [46, 204, 113], 'teal': [26, 188, 156],
  'purple': [155, 89, 182], 'orange': [230, 126, 34], 'grey': [149, 165, 166],
  'magenta': [255, 0, 255], 'mid-grey-brown': [120, 110, 100]
};
const bases = { 'light': [250, 249, 247], 'dark': [22, 22, 26] };
let mixUsed = 0, worst = Infinity, worstLabel = '';
for (const [bname, base] of Object.entries(bases)) {
  for (const [cname, cov] of Object.entries(covers)) {
    const r = F.coverInk(base, cov);
    const c1 = F.contrast(r.ink, r.bg), c2 = F.contrast(r.ink2, r.bg);
    const bad = c1 < 4.5 || c2 < 4.5;
    if (bad) { fail++; console.log('  FAIL ' + bname + '/' + cname + ' ink=' + c1.toFixed(2) + ' ink2=' + c2.toFixed(2)); }
    if (r.mix > 0) mixUsed++;
    if (Math.min(c1, c2) < worst) { worst = Math.min(c1, c2); worstLabel = bname + '/' + cname; }
  }
}
ok(mixUsed > 20, 'cover colour actually used in most cases (' + mixUsed + '/28)');
console.log('  worst-case contrast across 28 samples: ' + worst.toFixed(2) + ':1 (' + worstLabel + ')');
ok(worst >= 4.5, 'every cover/base pair clears WCAG AA 4.5:1 for body and secondary text');
// The engine must back the mix off rather than fail: black cover on light base is the
// classic mid-grey danger zone.
const danger = F.coverInk([250, 249, 247], [0, 0, 0]);
ok(danger.mix < 0.34, 'mid-grey danger zone reduces the mix (' + danger.mix + ')');
ok(F.contrast(danger.ink, danger.bg) >= 4.5, 'and still passes after backing off');

console.log('\n--- MusicBrainz matching (offline fixtures) ---');
ok(F.haveArtistQuery('Radiohead', 'Creep').includes('artist:"Radiohead"'), 'artist query');
ok(F.haveArtistQuery('Local file', 'Creep') === 'recording:"Creep"', 'title-only query for local files');
const rels = [
  { id: 'live-id', title: 'Live at Coachella', status: 'Official', date: '2017-04-14' },
  { id: 'boot-id', title: 'Creep', status: 'Bootleg', date: '1993-01-01' },
  { id: 'clean-id', title: 'Pablo Honey', status: 'Official', date: '1993-02-22' },
  { id: 'later-id', title: 'Greatest Hits', status: 'Official', date: '2008-06-01' }
];
ok(F.pickRelease(rels).id === 'clean-id', 'prefers official, non-live, earliest', F.pickRelease(rels));
ok(F.pickRelease([]) === null && F.pickRelease(null) === null, 'no releases → null');
const recs = [
  { score: 100, title: 'Creep', 'artist-credit': [{ name: 'Radiohead' }], releases: [] },
  { score: 96, title: 'Creep', 'artist-credit': [{ name: 'Radiohead' }],
    releases: [{ id: 'ph', title: 'Pablo Honey', status: 'Official', date: '1993-02-22' }] }
];
ok((F.pickMatch(recs, 'Radiohead', 'Creep') || {}).cover ===
   'https://coverartarchive.org/release/ph/front-250', 'skips the coverless first hit for one with art');
ok(F.pickMatch([{ score: 40, title: 'Creep', 'artist-credit': [{ name: 'Nobody' }], releases: [] }],
   'Radiohead', 'Creep') === null, 'rejects low scores');
ok(F.pickMatch([{ score: 99, title: 'Creep', 'artist-credit': [{ name: 'Some Cover Band' }],
   releases: [{ id: 'x', title: 'X', status: 'Official', date: '2000-01-01' }] }], 'Radiohead', 'Creep') === null,
   'rejects artist mismatch');
const nocov = F.pickMatch([{ score: 100, title: 'Creep', 'artist-credit': [{ name: 'Radiohead' }], releases: [] }],
   'Radiohead', 'Creep');
ok(nocov && nocov.cover === null && nocov.title === 'Creep', 'still returns a coverless match as fallback');

/* --- live API sanity (musicbrainz.org) --- */
async function live() {
  console.log('\n--- MusicBrainz live API ---');
  const q = encodeURIComponent(F.haveArtistQuery('Radiohead', 'Creep'));
  const r = await fetch('https://musicbrainz.org/ws/2/recording/?query=' + q + '&fmt=json&limit=5&inc=releases',
    { headers: { 'User-Agent': 'visualise-test/2.0 (local test)' } });
  if (r.status === 503) {
    console.log('  skip MusicBrainz rate-limited us (503) — offline fixtures still cover the logic');
    console.log('\n' + (fail === 0 ? 'ALL PASS (live check skipped)' : fail + ' FAILURE(S)') + '  (' + pass + ' assertions)');
    process.exit(fail === 0 ? 0 : 1);
  }
  ok(r.ok, 'search returns 200 (got ' + r.status + ')');
  const j = await r.json();
  const match = F.pickMatch(j.recordings || [], 'Radiohead', 'Creep');
  ok(!!match, 'found a match for Radiohead — Creep');
  ok(match && match.cover && match.cover.startsWith('https://coverartarchive.org/release/'),
     'match carries a cover URL', match && match.cover);
  console.log('  → ' + (match ? match.artist + ' — ' + match.title : 'none'));

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILURE(S)') + '  (' + pass + ' assertions)');
  process.exit(fail === 0 ? 0 : 1);
}
live().catch(function (e) {
  console.log('\nnetwork check skipped: ' + e.message);
  console.log('\n' + (fail === 0 ? 'ALL PASS (offline)' : fail + ' FAILURE(S)') + '  (' + pass + ' assertions)');
  process.exit(fail === 0 ? 0 : 1);
});
