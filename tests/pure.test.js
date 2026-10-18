#!/usr/bin/env node
/* visualise — pure-function tests.

   The page is a single file, so these functions are pulled out of index.html
   by brace matching (tests/extract.js) rather than copied here: the tests run
   the real code the browser runs. No browser and no network needed except the
   one live iTunes check at the end, which skips itself if it cannot reach it. */
'use strict';
const { readSource, extract } = require('./extract');
const source = readSource();

const names = ['hexToRgb', 'parseName', 'fmt', 'bandValue', 'normName', 'bigArtwork',
               'itunesQuery', 'pickTrack', 'splitIdentity', 'labelLooksLikeTrack',
               'srgbLum', 'contrast', 'mixRgb', 'coverInk', 'colourStr', 'parseColour'];
const preamble = 'var BAR_COUNT = 48;\nvar bins = new Uint8Array(1024);\n';
const body = names.map((n) => extract(source, n)).join('\n');
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

console.log('\n--- iTunes matching (offline fixtures) ---');
ok(F.normName('Get Lucky (Radio Edit)') === 'get lucky', 'strips parenthesised suffixes', F.normName('Get Lucky (Radio Edit)'));
ok(F.normName('Song - Remastered 2011') === 'song', 'strips remaster suffixes', F.normName('Song - Remastered 2011'));
ok(F.normName('AC/DC') === 'ac dc', 'punctuation collapses to spaces', F.normName('AC/DC'));
ok(F.bigArtwork('https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg') ===
   'https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg',
   '100x100bb → 600x600bb', F.bigArtwork('https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg'));
ok(F.bigArtwork(null) === null, 'no artwork URL → null');
ok(F.itunesQuery('Radiohead', 'Creep').indexOf('term=Radiohead%20Creep') !== -1, 'query carries both names');
ok(F.itunesQuery('Local file', 'Creep').indexOf('term=Creep') !== -1, 'local files query the title alone');

const results = [
  { trackName: 'Creep', artistName: 'Radiohead', collectionName: 'Pablo Honey', artworkUrl100: 'https://x/100x100bb.jpg' },
  { trackName: 'Creep (Live)', artistName: 'Some Cover Band', collectionName: 'Tribute', artworkUrl100: 'https://y/100x100bb.jpg' },
  { trackName: 'Creepin', artistName: 'Radiohead', collectionName: 'Other', artworkUrl100: 'https://z/100x100bb.jpg' }
];
const best = F.pickTrack(results, 'Radiohead', 'Creep');
ok(best && best.title === 'Creep' && best.artist === 'Radiohead', 'exact title + artist wins', best);
ok(best && best.art === 'https://x/600x600bb.jpg', 'artwork is upgraded to 600x600', best && best.art);
ok(best && best.album === 'Pablo Honey', 'album carried through');
const bare = F.pickTrack(results, '', 'Creep');
ok(bare && bare.artist === 'Radiohead', 'a bare typed title still matches (artist filled in later)', bare);
ok(F.pickTrack([{ trackName: 'Creep', artistName: 'Some Cover Band', artworkUrl100: 'https://c/100x100bb.jpg' }],
   'Radiohead', 'Creep') === null, 'artist mismatch is rejected even with an exact title');
ok(F.pickTrack([{ trackName: 'Bohemian Rhapsody', artistName: 'Queen', artworkUrl100: 'https://q/100x100bb.jpg' }],
   'Radiohead', 'Creep') === null, 'unrelated result is rejected');
ok(F.pickTrack([{ trackName: 'Creep', artistName: 'Radiohead' }], 'Radiohead', 'Creep') === null,
   'a result with no artwork is skipped (art is the point)');
ok(F.pickTrack([], 'Radiohead', 'Creep') === null && F.pickTrack(null, 'x', 'y') === null, 'empty results → null');

console.log('\n--- typed identity ---');
const si = F.splitIdentity('Daft Punk - Get Lucky');
ok(si.artist === 'Daft Punk' && si.title === 'Get Lucky' && si.bare === false, 'splits "Artist - Title"', si);
const si2 = F.splitIdentity('Get Lucky');
ok(si2.title === 'Get Lucky' && si2.artist === '' && si2.bare === true, 'bare title stays bare', si2);
ok(F.splitIdentity('Get Lucky \u2013 Daft Punk').artist === 'Get Lucky', 'splits on an en dash too');
// regression guard: this must NOT reuse the filename parser, which strips ".ext"
const si3 = F.splitIdentity('Mr. Brightside');
ok(si3.title === 'Mr. Brightside' && si3.bare === true, 'does not mistake a dot for a file extension', si3);

console.log('\n--- capture label heuristic (best-effort metadata) ---');
ok(F.labelLooksLikeTrack('Humans Who Killed Predators With Their Bare Hands - YouTube') === true,
   'a tab title looks like a track');
ok(F.labelLooksLikeTrack('Entire Screen') === false, 'picker labels are rejected: Entire Screen');
ok(F.labelLooksLikeTrack('Screen 1') === false, 'picker labels are rejected: Screen 1');
ok(F.labelLooksLikeTrack('Chrome Tab') === false, 'picker labels are rejected: Chrome Tab');
ok(F.labelLooksLikeTrack('') === false && F.labelLooksLikeTrack(null) === false, 'empty label');
ok(F.labelLooksLikeTrack('12345') === false && F.labelLooksLikeTrack('tab') === false, 'no letters / too short');

/* --- live API sanity (itunes.apple.com) --- */
async function live() {
  console.log('\n--- iTunes live API ---');
  let j = null;
  try {
    const r = await fetch(F.itunesQuery('Radiohead', 'Creep'));
    ok(r.ok, 'search returns 200 (got ' + r.status + ')');
    if (r.ok) j = await r.json();
  } catch (e) {
    console.log('  skip iTunes unreachable: ' + e.message);
  }
  if (j) {
    const m = F.pickTrack(j.results || [], 'Radiohead', 'Creep');
    ok(!!m, 'found a match for Radiohead — Creep');
    ok(m && m.art && m.art.indexOf('600x600') !== -1, 'match carries 600x600 artwork', m && m.art);
    console.log('  -> ' + (m ? m.artist + ' — ' + m.title + ' (' + m.album + ')' : 'none'));
    if (m && m.art) {
      // The colour engine reads pixels off this image, which silently fails on
      // a tainted canvas — so the host MUST send Access-Control-Allow-Origin.
      const a = await fetch(m.art, { headers: { Origin: 'https://liqwidcell-dot.github.io' } });
      const acao = a.headers.get('access-control-allow-origin');
      ok(acao === '*', 'artwork host allows cross-origin reads (ACAO *)', acao);
    }
  }

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILURE(S)') + '  (' + pass + ' assertions)');
  process.exit(fail === 0 ? 0 : 1);
}
live().catch(function (e) {
  console.log('\nnetwork check skipped: ' + e.message);
  console.log('\n' + (fail === 0 ? 'ALL PASS (offline)' : fail + ' FAILURE(S)') + '  (' + pass + ' assertions)');
  process.exit(fail === 0 ? 0 : 1);
});
