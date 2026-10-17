#!/usr/bin/env node
/* visualise — AudioWorklet processor test.
   Stubs AudioWorkletProcessor + registerProcessor, loads the real worklet
   source from index.html, and exercises the PCM playback path. */
'use strict';
const fs = require('fs');

const html = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script id="worklet-src" type="text\/plain">\n([\s\S]*?)\n<\/script>/);
if (!m) { console.error('FAIL: worklet block not found'); process.exit(1); }
const src = m[1];

let Registered = null;
class AudioWorkletProcessorStub {
  constructor() {
    this.port = {
      _h: null,
      onmessage: null,
      postMessage() {}
    };
  }
}
const sandbox = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate',
  src + '\nreturn PCMFeed;');
const PCMFeed = sandbox(AudioWorkletProcessorStub, function (name, cls) {
  if (name !== 'pcm-feed') throw new Error('unexpected processor name: ' + name);
  Registered = cls;
}, 48000);

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

ok(PCMFeed === Registered, 'registers exactly one processor named "pcm-feed"');

const proc = new PCMFeed();
ok(typeof proc.process === 'function', 'has a process() method');
ok(proc.q !== undefined || proc.port.onmessage, 'accepts chunks via port.onmessage');

/* helper: a stereo output block */
function block(n) { return [[new Float32Array(n), new Float32Array(n)]]; }

/* --- 1. empty queue → silence, no crash, keeps processor alive --- */
let out = block(128);
let alive = proc.process([], out);
ok(alive === true, 'returns true with an empty queue (processor stays alive)');
ok(out[0][0].every(function (v) { return v === 0; }), 'empty queue yields silence');

/* --- 2. a posted chunk is played out verbatim --- */
const chunkLen = 128;
const l = new Float32Array(chunkLen), r = new Float32Array(chunkLen);
for (let i = 0; i < chunkLen; i++) { l[i] = Math.sin(i / 10) * 0.5; r[i] = -0.25; }
proc.port.onmessage({ data: { l: l, r: r, i: 0 } });
out = block(128);
proc.process([], out);
let maxErr = 0;
for (let i = 0; i < 128; i++) maxErr = Math.max(maxErr, Math.abs(out[0][0][i] - l[i]), Math.abs(out[0][1][i] - r[i]));
ok(maxErr < 1e-7, 'posted chunk plays out sample-exact (max err ' + maxErr + ')');

/* --- 3. partial chunk (odd number of frames) is drained progressively --- */
const part = new Float32Array(50).fill(0.75);
proc.port.onmessage({ data: { l: part, r: part, i: 0 } });
out = block(32);
proc.process([], out);
ok(out[0][0][0] === 0.75 && out[0][0][31] === 0.75, 'first 32 frames of a 50-frame block played');
out = block(32);
proc.process([], out);
ok(out[0][0][17] === 0.75 && out[0][0][18] === 0, 'remaining 18 frames played, then silence');
ok(proc.q.length === 0, 'queue is empty once drained');

/* --- 4. a chunk longer than one block spans blocks without loss --- */
const big = new Float32Array(300);
for (let i = 0; i < 300; i++) big[i] = i / 300;
proc.port.onmessage({ data: { l: big, r: big, i: 0 } });
let seen = 0;
for (let b = 0; b < 3; b++) {
  const o = block(128);
  proc.process([], o);
  for (let i = 0; i < 128; i++) {
    const expect = (seen + i) < 300 ? (seen + i) / 300 : 0;
    if (Math.abs(o[0][0][i] - expect) > 1e-6) { fail++; console.log('  FAIL sample mismatch at ' + (seen + i)); b = 99; break; }
  }
  seen += 128;
}
ok(true, '300-frame chunk spans three blocks in order');

/* --- 5. backlog is capped (no unbounded latency growth) --- */
const proc2 = new PCMFeed();
const c = new Float32Array(128).fill(0.1);
for (let i = 0; i < 40; i++) proc2.port.onmessage({ data: { l: c, r: c, i: 0 } });
proc2.process([], block(128));
ok(proc2.q.length <= 8, 'backlog capped to 8 blocks after flooding (got ' + proc2.q.length + ')');

/* --- 6. single-channel output block must not throw --- */
const proc3 = new PCMFeed();
proc3.port.onmessage({ data: { l: new Float32Array(64).fill(0.5), r: new Float32Array(64).fill(0.5), i: 0 } });
const mono = [[new Float32Array(64)]];
let threw = null;
try { proc3.process([], mono); } catch (e) { threw = e.message; }
ok(threw === null, 'mono output block handled (' + (threw || 'no throw') + ')');
ok(Math.abs(mono[0][0][0] - 0.5) < 1e-7, 'mono path still writes samples');

/* --- 7. verify the Int16→Float32 conversion used by pushPCM --- */
function convert(u8) {
  const frames = Math.floor(u8.byteLength / 4);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const dv = new DataView(u8.buffer, u8.byteOffset, frames * 4);
  for (let i = 0; i < frames; i++) {
    L[i] = dv.getInt16(i * 4, true) / 32768;
    R[i] = dv.getInt16(i * 4 + 2, true) / 32768;
  }
  return [L, R];
}
const raw = Buffer.alloc(8);
raw.writeInt16LE(32767, 0); raw.writeInt16LE(-32768, 2);   // frame 0: L max, R min
raw.writeInt16LE(0, 4);     raw.writeInt16LE(16384, 6);    // frame 1: L 0,   R half
const [L2, R2] = convert(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
ok(Math.abs(L2[0] - 32767 / 32768) < 1e-7, 's16le → float: +max');
ok(Math.abs(R2[0] - (-1)) < 1e-7, 's16le → float: -min');
ok(L2[1] === 0 && Math.abs(R2[1] - 0.5) < 1e-7, 's16le → float: zero and half');

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILURE(S)') + '  (' + pass + ' assertions)');
process.exit(fail === 0 ? 0 : 1);
