#!/usr/bin/env node
/* visualise — embedded cover art extractor tests.

   The extractor lives inside index.html (the page is one file), so it is pulled
   out of the real page by brace matching (tests/extract.js) — the same code the
   browser runs, never a copy. The page reads art and text tags in one pass
   (parseMediaTags), so this suite looks at the art half of that; tests/file-tags
   covers the other half. Every input below is synthesised in memory: nothing is
   downloaded and no audio file is needed. */
'use strict';
const { readSource, extract } = require('./extract');
const source = readSource();
const parseMediaTags = new Function('return ' + extract(source, 'parseMediaTags') + ';')();
const extractEmbeddedArt = (bytes) => {
  const parsed = parseMediaTags(bytes);
  return parsed ? parsed.art : null;
};

var pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, actual === expected ? undefined : { got: actual, expected: expected });
}

function bytesEqual(a, b) {
  if (!a || !b) return false;
  a = new Uint8Array(a); b = new Uint8Array(b);
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* byte building helpers                                               */
/* ------------------------------------------------------------------ */

function ascii(s) {
  var out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function bytes() {
  var list = [];
  for (var i = 0; i < arguments.length; i++) {
    var a = arguments[i];
    if (typeof a === 'number') list.push(a & 0xff);
    else for (var j = 0; j < a.length; j++) list.push(a[j] & 0xff);
  }
  return new Uint8Array(list);
}

function u32be(n) {
  return [((n >>> 24) & 0xff), ((n >>> 16) & 0xff), ((n >>> 8) & 0xff), (n & 0xff)];
}

function u24be(n) {
  return [((n >>> 16) & 0xff), ((n >>> 8) & 0xff), (n & 0xff)];
}

function synchsafe(n) {
  return [((n >>> 21) & 0x7f), ((n >>> 14) & 0x7f), ((n >>> 7) & 0x7f), (n & 0x7f)];
}

/* ------------------------------------------------------------------ */
/* sample pictures                                                     */
/* ------------------------------------------------------------------ */

function jpegBytes(seed, extra) {
  var body = [0xff, 0xd8, 0xff, 0xe0];
  for (var i = 0; i < (extra || 40); i++) body.push((seed + i * 7) & 0xff);
  body.push(0xff, 0xd9);
  return new Uint8Array(body);
}

function pngBytes(seed, extra) {
  var body = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (var i = 0; i < (extra || 40); i++) body.push((seed + i * 3) & 0xff);
  return new Uint8Array(body);
}

function gifBytes() {
  return bytes(ascii('GIF89a'), [1, 2, 3, 4, 5, 6, 7, 8]);
}

/* ------------------------------------------------------------------ */
/* ID3v2 builders                                                      */
/* ------------------------------------------------------------------ */

// v2.3 / v2.4 frame: 4-char id, 4-byte size, 2 flag bytes
function frameV23(id, body, synchsafeSize) {
  var sizeBytes = synchsafeSize ? synchsafe(body.length) : u32be(body.length);
  return bytes(ascii(id), sizeBytes, [0, 0], body);
}

// v2.2 frame: 3-char id, 3-byte size, no flags
function frameV22(id, body) {
  return bytes(ascii(id), u24be(body.length), body);
}

// APIC body for v2.3 / v2.4
function apicBody(mime, pictureType, enc, descBytes, pic) {
  var wide = (enc === 1 || enc === 2);
  return bytes(
    [enc],
    ascii(mime), [0],
    [pictureType],
    descBytes || [], wide ? [0, 0] : [0],
    pic
  );
}

// PIC body for v2.2
function picBody(fmt, pictureType, enc, descBytes, pic) {
  var wide = (enc === 1 || enc === 2);
  return bytes(
    [enc],
    ascii(fmt),
    [pictureType],
    descBytes || [], wide ? [0, 0] : [0],
    pic
  );
}

// Whole ID3v2.3 tag. opts: { flags, padding, extHeaderV23 }
function id3v23(frames, opts) {
  opts = opts || {};
  var raw = bytes.apply(null, frames);
  if (opts.extHeaderV23) {
    // v2.3 extended header: size (excludes this field) = 6, flags(2), padding(4)
    raw = bytes(u32be(6), [0, 0], u32be(opts.padding || 0), raw);
  }
  if (opts.unsync) raw = unsynchronise(raw);
  var body = raw;
  if (opts.padding) body = bytes(body, new Uint8Array(opts.padding));
  return bytes(ascii('ID3'), [3, 0, opts.flags || 0], synchsafe(body.length), body);
}

function id3v24(frames, opts) {
  opts = opts || {};
  var body = bytes.apply(null, frames);
  if (opts.padding) body = bytes(body, new Uint8Array(opts.padding));
  return bytes(ascii('ID3'), [4, 0, opts.flags || 0], synchsafe(body.length), body);
}

function id3v22(frames, opts) {
  opts = opts || {};
  var body = bytes.apply(null, frames);
  if (opts.padding) body = bytes(body, new Uint8Array(opts.padding));
  return bytes(ascii('ID3'), [2, 0, opts.flags || 0], synchsafe(body.length), body);
}

// Unsynchronisation: insert 0x00 after every 0xFF.
function unsynchronise(buf) {
  var out = [];
  for (var i = 0; i < buf.length; i++) {
    out.push(buf[i]);
    if (buf[i] === 0xff) out.push(0x00);
  }
  return new Uint8Array(out);
}

/* ------------------------------------------------------------------ */
/* MP4 builders                                                        */
/* ------------------------------------------------------------------ */

function box(type, payload, force64) {
  payload = payload || new Uint8Array(0);
  if (force64) {
    var large = 16 + payload.length;
    return bytes(u32be(1), ascii(type), u32be(Math.floor(large / 4294967296)), u32be(large % 4294967296), payload);
  }
  return bytes(u32be(8 + payload.length), ascii(type), payload);
}

function dataAtom(code, pic) {
  return box('data', bytes(u32be(code), u32be(0), pic));
}

function mp4WithCovr(dataAtoms, extraTopAtoms) {
  var covr = box('covr', bytes.apply(null, dataAtoms));
  var ilst = box('ilst', covr);
  var meta = box('meta', bytes(u32be(0), ilst)); // full box: version/flags
  var udta = box('udta', meta);
  var moov = box('moov', udta);
  var ftyp = box('ftyp', bytes(ascii('M4A '), u32be(0x200), ascii('M4A '), ascii('isom')));
  var parts = [ftyp];
  if (extraTopAtoms) for (var i = 0; i < extraTopAtoms.length; i++) parts.push(extraTopAtoms[i]);
  parts.push(moov);
  return bytes.apply(null, parts);
}

/* ------------------------------------------------------------------ */
/* FLAC builders                                                       */
/* ------------------------------------------------------------------ */

function flacBlock(type, payload, last) {
  return bytes([type | (last ? 0x80 : 0)], u24be(payload.length), payload);
}

function flacPictureBlock(pictureType, mime, desc, w, h, depth, colors, data) {
  return bytes(
    u32be(pictureType),
    u32be(mime.length), ascii(mime),
    u32be(desc.length), ascii(desc),
    u32be(w), u32be(h), u32be(depth), u32be(colors),
    u32be(data.length), data
  );
}

function streaminfoBlock(last) {
  return flacBlock(0, new Uint8Array(34), last);
}

/* ================================================================== */
/* TESTS                                                               */
/* ================================================================== */

console.log('--- ID3v2.3 APIC JPEG ---');
(function () {
  var jpg = jpegBytes(10);
  var tag = id3v23([frameV23('APIC', apicBody('image/jpeg', 3, 0, ascii('front cover'), jpg))]);
  var r = extractEmbeddedArt(tag);
  ok(r !== null, 'ID3v2.3 APIC JPEG: result is not null');
  if (r) {
    eq(r.mime, 'image/jpeg', 'ID3v2.3 APIC JPEG: mime is image/jpeg');
    ok(bytesEqual(r.bytes, jpg), 'ID3v2.3 APIC JPEG: returned bytes are byte-identical');
  } else {
    fail += 2; console.log('FAIL  ID3v2.3 APIC JPEG: mime is image/jpeg');
    console.log('FAIL  ID3v2.3 APIC JPEG: returned bytes are byte-identical');
  }
})();

console.log('--- ID3v2.3 APIC with UTF-16 description ---');
(function () {
  var jpg = jpegBytes(20);
  // BOM + "ab" in UTF-16LE, then the two-zero-byte terminator.
  var utf16desc = bytes([0xff, 0xfe], ascii('a'), [0], ascii('b'), [0]);
  var tag = id3v23([frameV23('APIC', apicBody('image/jpeg', 3, 1, utf16desc, jpg))]);
  var r = extractEmbeddedArt(tag);
  ok(r !== null, 'ID3v2.3 UTF-16 description: result is not null');
  ok(r !== null && bytesEqual(r.bytes, jpg), 'ID3v2.3 UTF-16 description: picture start not corrupted');
  ok(r !== null && bytesEqual(r.bytes.slice(0, 3), [0xff, 0xd8, 0xff]), 'ID3v2.3 UTF-16 description: picture begins with JPEG SOI');
})();

console.log('--- ID3v2.4 synchsafe frame size + PNG APIC ---');
(function () {
  var png = pngBytes(30);
  var tag = id3v24([frameV23('APIC', apicBody('image/png', 3, 0, ascii('art'), png), true)]);
  var r = extractEmbeddedArt(tag);
  ok(r !== null, 'ID3v2.4 synchsafe PNG: result is not null');
  eq(r && r.mime, 'image/png', 'ID3v2.4 synchsafe PNG: mime is image/png');
  ok(r !== null && bytesEqual(r.bytes, png), 'ID3v2.4 synchsafe PNG: bytes byte-identical');
})();

console.log('--- ID3v2.2 PIC (JPG) ---');
(function () {
  var jpg = jpegBytes(40);
  var tag = id3v22([frameV22('PIC', picBody('JPG', 3, 0, ascii('c'), jpg))]);
  var r = extractEmbeddedArt(tag);
  ok(r !== null, 'ID3v2.2 PIC JPG: result is not null');
  eq(r && r.mime, 'image/jpeg', 'ID3v2.2 PIC JPG: mime is image/jpeg');
  ok(r !== null && bytesEqual(r.bytes, jpg), 'ID3v2.2 PIC JPG: bytes byte-identical');
})();

console.log('--- ID3v2.3 extended header flag (0x40) ---');
(function () {
  var jpg = jpegBytes(50);
  var tag = id3v23([frameV23('APIC', apicBody('image/jpeg', 3, 0, ascii('x'), jpg))], { flags: 0x40, extHeaderV23: true });
  var r = extractEmbeddedArt(tag);
  ok(r !== null, 'ID3v2.3 extended header: result is not null');
  ok(r !== null && bytesEqual(r.bytes, jpg), 'ID3v2.3 extended header: bytes byte-identical');
})();

console.log('--- ID3v2.3 unsynchronisation with FF 00 inside picture ---');
(function () {
  var jpg = jpegBytes(60);
  // Guarantee the payload contains an FF 00 sequence.
  var pic = bytes(jpg, [0xff, 0x00, 0x11, 0xff, 0xff, 0x00, 0x22]);
  var tag = id3v23([frameV23('APIC', apicBody('image/jpeg', 3, 0, ascii('u'), pic))], { flags: 0x80, unsync: true });
  var r = extractEmbeddedArt(tag);
  ok(r !== null, 'ID3v2.3 unsynchronisation: result is not null');
  ok(r !== null && bytesEqual(r.bytes, pic), 'ID3v2.3 unsynchronisation: bytes de-unsynchronised exactly');
})();

console.log('--- ID3v2.3 padding after APIC frame ---');
(function () {
  var jpg = jpegBytes(70);
  var tag = id3v23([frameV23('APIC', apicBody('image/jpeg', 3, 0, ascii('p'), jpg))], { padding: 128 });
  var r = extractEmbeddedArt(tag);
  ok(r !== null, 'ID3v2.3 padding: result is not null');
  ok(r !== null && bytesEqual(r.bytes, jpg), 'ID3v2.3 padding: bytes byte-identical');
})();

console.log('--- Multiple APIC frames: largest wins ---');
(function () {
  var small = jpegBytes(1, 20);
  var big = jpegBytes(2, 200);
  var tag = id3v23([
    frameV23('APIC', apicBody('image/jpeg', 4, 0, ascii('back'), small)),
    frameV23('APIC', apicBody('image/jpeg', 4, 0, ascii('back2'), big))
  ]);
  var r = extractEmbeddedArt(tag);
  ok(r !== null && bytesEqual(r.bytes, big), 'Two APIC (both type 4): largest wins');
})();

console.log('--- Multiple APIC frames: front cover (type 3) wins over type 4 ---');
(function () {
  var frontSmall = jpegBytes(3, 20);
  var backBig = jpegBytes(4, 400);
  var tag = id3v23([
    frameV23('APIC', apicBody('image/jpeg', 4, 0, ascii('back'), backBig)),
    frameV23('APIC', apicBody('image/jpeg', 3, 0, ascii('front'), frontSmall))
  ]);
  var r = extractEmbeddedArt(tag);
  ok(r !== null && bytesEqual(r.bytes, frontSmall), 'Type 3 front cover wins over larger type 4');
})();

console.log('--- APIC MIME "-->" is a URL -> null ---');
(function () {
  var tag = id3v23([frameV23('APIC', apicBody('-->', 3, 0, ascii('u'), ascii('http://example.com/a.jpg')))]);
  ok(extractEmbeddedArt(tag) === null, 'APIC MIME "-->" returns null');
})();

console.log('--- APIC with empty MIME is sniffed ---');
(function () {
  var jpg = jpegBytes(80);
  var tag = id3v23([frameV23('APIC', apicBody('', 3, 0, ascii('s'), jpg))]);
  var r = extractEmbeddedArt(tag);
  eq(r && r.mime, 'image/jpeg', 'Empty MIME + JPEG bytes sniffs to image/jpeg');
  ok(r !== null && bytesEqual(r.bytes, jpg), 'Empty MIME + JPEG bytes: bytes intact');
})();

console.log('--- APIC empty MIME + GIF sniff ---');
(function () {
  var gif = gifBytes();
  var tag = id3v23([frameV23('APIC', apicBody('', 3, 0, ascii('g'), gif))]);
  var r = extractEmbeddedArt(tag);
  eq(r && r.mime, 'image/gif', 'Empty MIME + GIF bytes sniffs to image/gif');
})();

console.log('--- MP4 covr data type 13 (JPEG) ---');
(function () {
  var jpg = jpegBytes(90);
  var file = mp4WithCovr([dataAtom(13, jpg)]);
  var r = extractEmbeddedArt(file);
  ok(r !== null, 'MP4 covr type 13: result is not null');
  eq(r && r.mime, 'image/jpeg', 'MP4 covr type 13: mime is image/jpeg');
  ok(r !== null && bytesEqual(r.bytes, jpg), 'MP4 covr type 13: bytes byte-identical');
})();

console.log('--- MP4 covr data type 14 (PNG) ---');
(function () {
  var png = pngBytes(100);
  var file = mp4WithCovr([dataAtom(14, png)]);
  var r = extractEmbeddedArt(file);
  eq(r && r.mime, 'image/png', 'MP4 covr type 14: mime is image/png');
  ok(r !== null && bytesEqual(r.bytes, png), 'MP4 covr type 14: bytes byte-identical');
})();

console.log('--- MP4 with unrelated large atom and 64-bit size atom before moov ---');
(function () {
  var jpg = jpegBytes(110);
  var largeFree = box('free', new Uint8Array(4096), true);          // 64-bit largesize
  var mdat = box('mdat', new Uint8Array(2048));                      // unrelated large atom
  var file = mp4WithCovr([dataAtom(13, jpg)], [largeFree, mdat]);
  var r = extractEmbeddedArt(file);
  ok(r !== null, 'MP4 with 64-bit + large atom: result is not null');
  ok(r !== null && bytesEqual(r.bytes, jpg), 'MP4 with 64-bit + large atom: bytes byte-identical');
})();

console.log('--- MP4 with multiple covr: largest wins ---');
(function () {
  var small = jpegBytes(1, 10);
  var big = pngBytes(5, 500);
  var file = mp4WithCovr([dataAtom(13, small), dataAtom(14, big)]);
  var r = extractEmbeddedArt(file);
  ok(r !== null && bytesEqual(r.bytes, big), 'MP4 multiple covr: largest wins');
})();

console.log('--- FLAC PICTURE block ---');
(function () {
  var png = pngBytes(120);
  var file = bytes(
    ascii('fLaC'),
    streaminfoBlock(false),
    flacBlock(6, flacPictureBlock(3, 'image/png', 'front', 100, 100, 24, 0, png), true)
  );
  var r = extractEmbeddedArt(file);
  ok(r !== null, 'FLAC PICTURE: result is not null');
  eq(r && r.mime, 'image/png', 'FLAC PICTURE: mime is image/png');
  ok(r !== null && bytesEqual(r.bytes, png), 'FLAC PICTURE: bytes byte-identical');
})();

console.log('--- FLAC with STREAMINFO only ---');
(function () {
  var file = bytes(ascii('fLaC'), streaminfoBlock(true));
  ok(extractEmbeddedArt(file) === null, 'FLAC STREAMINFO only returns null');
})();

console.log('--- FLAC PICTURE type 3 preferred over larger type 4 ---');
(function () {
  var front = jpegBytes(1, 10);
  var back = jpegBytes(2, 300);
  var file = bytes(
    ascii('fLaC'),
    streaminfoBlock(false),
    flacBlock(6, flacPictureBlock(4, 'image/jpeg', 'back', 1, 1, 24, 0, back), false),
    flacBlock(6, flacPictureBlock(3, 'image/jpeg', 'front', 1, 1, 24, 0, front), true)
  );
  var r = extractEmbeddedArt(file);
  ok(r !== null && bytesEqual(r.bytes, front), 'FLAC: type 3 front cover preferred');
})();

console.log('--- Negatives ---');
(function () {
  ok(extractEmbeddedArt(new Uint8Array(0)) === null, 'Empty input returns null');
  ok(extractEmbeddedArt(null) === null, 'null input returns null');
  ok(extractEmbeddedArt(undefined) === null, 'undefined input returns null');

  // deterministic pseudo-random bytes
  var rnd = new Uint8Array(2048);
  var s = 12345;
  for (var i = 0; i < rnd.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    rnd[i] = (s >>> 16) & 0xff;
  }
  // make sure it does not accidentally start with a known signature
  rnd[0] = 0x11; rnd[1] = 0x22; rnd[2] = 0x33; rnd[3] = 0x44;
  ok(extractEmbeddedArt(rnd) === null, 'Random bytes return null');

  ok(extractEmbeddedArt(ascii('this is not an audio file at all, just text')) === null,
     'File with no tags returns null');

  // truncated ID3 tag: build a valid one, then chop it in half
  var jpg = jpegBytes(130);
  var full = id3v23([frameV23('APIC', apicBody('image/jpeg', 3, 0, ascii('t'), jpg))], { padding: 64 });
  var half = full.slice(0, Math.floor(full.length / 2));
  ok(extractEmbeddedArt(half) === null, 'Truncated ID3 tag returns null');

  // APIC frame size runs past the end of the buffer
  var overrun = bytes(
    ascii('ID3'), [3, 0, 0], synchsafe(20),
    ascii('APIC'), u32be(9999), [0, 0], [0], ascii('image/jpeg'), [0], [3], [0], [1, 2, 3]
  );
  ok(extractEmbeddedArt(overrun) === null, 'APIC frame size past end of buffer returns null');

  // malformed MP4-ish: atom claims a huge size
  var badMp4 = bytes(ascii('ftyp'), u32be(0x7fffffff), ascii('M4A '), ascii('isom'));
  ok(extractEmbeddedArt(badMp4) === null, 'MP4 with absurd atom size returns null');

  // FLAC truncated in the middle of the PICTURE block
  var pngFull = bytes(ascii('fLaC'), streaminfoBlock(false),
    flacBlock(6, flacPictureBlock(3, 'image/png', 'f', 1, 1, 24, 0, pngBytes(140)), true));
  ok(extractEmbeddedArt(pngFull.slice(0, 30)) === null, 'Truncated FLAC returns null');
})();

console.log('--- ArrayBuffer and Buffer inputs ---');
(function () {
  var jpg = jpegBytes(150);
  var tag = id3v23([frameV23('APIC', apicBody('image/jpeg', 3, 0, ascii('b'), jpg))]);

  var ab = new Uint8Array(tag).buffer; // exact-length ArrayBuffer
  var r1 = extractEmbeddedArt(ab);
  ok(r1 !== null && bytesEqual(r1.bytes, jpg), 'ArrayBuffer input works');

  var bufIn = Buffer.from(tag);
  var r2 = extractEmbeddedArt(bufIn);
  ok(r2 !== null && bytesEqual(r2.bytes, jpg), 'Node Buffer input works');

  // Buffer that is a view into a shared pool with a non-zero byteOffset
  var pooled = Buffer.concat([Buffer.from([9, 9, 9]), Buffer.from(tag), Buffer.from([9])]);
  var view = pooled.subarray(3, 3 + tag.length);
  var r3 = extractEmbeddedArt(view);
  ok(r3 !== null && bytesEqual(r3.bytes, jpg), 'Offset Buffer view works');

  // plain array of numbers
  var r4 = extractEmbeddedArt(Array.prototype.slice.call(tag));
  ok(r4 !== null && bytesEqual(r4.bytes, jpg), 'Plain number array input works');
})();

console.log('--- Ogg is intentionally unsupported ---');
(function () {
  // Minimal Ogg page header, no picture support shipped.
  var ogg = bytes(ascii('OggS'), [0, 2], new Uint8Array(64));
  ok(extractEmbeddedArt(ogg) === null, 'Ogg input returns null (deliberately unsupported)');
})();

/* ------------------------------------------------------------------ */
/* summary                                                             */
/* ------------------------------------------------------------------ */

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILURE(S)') + '  (' + (pass + fail) + ' assertions)');
process.exit(fail === 0 ? 0 : 1);

