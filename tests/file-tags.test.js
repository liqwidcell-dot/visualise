#!/usr/bin/env node
/* visualise — dropped-file text tag tests.

   A dropped file is asked what it is: title, artist, album, year, track, genre
   out of ID3v2 (v2.2/2.3/2.4), FLAC Vorbis comments and MP4 ilst atoms. The
   parser lives inside index.html (the page is one file), so it is pulled out of
   the real page by brace matching (tests/extract.js) — the same code the
   browser runs, never a copy. Every file below is synthesised in memory:
   nothing is downloaded and no audio is decoded. */

'use strict';
const { readSource, extract } = require('./extract');

const source = readSource();
const parseMediaTags = new Function('return ' + extract(source, 'parseMediaTags') + ';')();
const extractTags = (bytes) => {
  const parsed = parseMediaTags(bytes);
  return parsed ? parsed.tags : null;
};
const extractArt = (bytes) => {
  const parsed = parseMediaTags(bytes);
  return parsed ? parsed.art : null;
};

var pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : '')); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, actual === expected ? undefined : { got: actual, expected: expected });
}

/* ------------------------------------------------------------------ */
/* byte builders                                                       */
/* ------------------------------------------------------------------ */

const u8 = (text, enc) => Array.from(Buffer.from(text, enc || 'latin1'));
const ascii = (s) => u8(s, 'latin1');
const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be24 = (n) => [(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const synchsafe = (n) => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
const utf16be = (text) => {
  const le = Buffer.from(text, 'utf16le');
  const out = [];
  for (let i = 0; i < le.length; i += 2) out.push(le[i + 1], le[i]);
  return out;
};
const cat = (...parts) => [].concat(...parts);

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd9];

/* --- ID3v2 --- */

// Text body: encoding byte, then the text (UTF-16 carries a BOM).
function id3Text(text, enc) {
  if (enc === 0) return cat(0, u8(text, 'latin1'));
  if (enc === 1) return cat(1, [0xff, 0xfe], u8(text, 'utf16le'));
  if (enc === 2) return cat(2, [0xfe, 0xff], utf16be(text));
  return cat(3, u8(text, 'utf8'));
}
const frame23 = (id, body) => cat(ascii(id), be32(body.length), [0, 0], body);
const frame24 = (id, body) => cat(ascii(id), synchsafe(body.length), [0, 0], body);
const frame22 = (id, body) => cat(ascii(id), be24(body.length), body);
const text23 = (id, text, enc) => frame23(id, id3Text(text, enc));
const text24 = (id, text, enc) => frame24(id, id3Text(text, enc));

function id3(major, frames, flags, sizeOverride) {
  const body = cat(...frames);
  const size = sizeOverride === undefined ? body.length : sizeOverride;
  return cat(ascii('ID3'), [major, 0, flags || 0], synchsafe(size), body);
}

// APIC (v2.3/2.4): enc, mime NUL, picture type, description NUL, data.
function apic(mime, description, data, pictureType) {
  return cat([0], ascii(mime), [0], [pictureType === undefined ? 3 : pictureType], [0], data);
}

// Unsynchronisation, as a writer applies it: 0xFF 0x00 after every 0xFF.
function unsync(bytes) {
  const out = [];
  for (const b of bytes) {
    out.push(b);
    if (b === 0xff) out.push(0x00);
  }
  return out;
}

/* --- FLAC --- */
const flacBlock = (type, isLast, body) => cat([(isLast ? 0x80 : 0) | type], be24(body.length), body);
const flac = (blocks) => cat(ascii('fLaC'), ...blocks);

// Vorbis comment block: LE vendor, then LE length-prefixed KEY=value lines.
function vorbis(pairs, vendor) {
  const v = u8(vendor === undefined ? 'visualise test' : vendor, 'utf8');
  const out = cat(le32(v.length), v, le32(pairs.length));
  for (const line of pairs) {
    const s = u8(line, 'utf8');
    out.push(...le32(s.length), ...s);
  }
  return out;
}

// FLAC PICTURE: everything big-endian, unlike the comment block.
function flacPicture(mime, data, pictureType) {
  const m = ascii(mime);
  return cat(be32(pictureType === undefined ? 3 : pictureType), be32(m.length), m,
             be32(0), [], be32(64), be32(64), be32(24), be32(0), be32(data.length), data);
}

/* --- MP4 --- */
const box = (type, body) => cat(be32(8 + body.length), ascii(type), body);
const dataAtom = (code, payload) => box('data', cat(be32(code), [0, 0, 0, 0], payload));

function mp4(entries) {
  const ilst = cat(...entries.map(([name, body]) => box(name, body)));
  const meta = box('meta', cat([0, 0, 0, 0], box('ilst', ilst)));
  return cat(box('ftyp', ascii('M4A ')), box('moov', box('udta', meta)));
}

const COPY = '\u00a9';   // the 0xA9 byte that prefixes MP4 tag names
const NAM = COPY + 'nam', ART = COPY + 'ART', ALB = COPY + 'alb';
const DAY = COPY + 'day', GEN = COPY + 'gen';

/* ------------------------------------------------------------------ */
/* ID3v2                                                               */
/* ------------------------------------------------------------------ */

console.log('--- ID3v2.3, latin-1 ---');
{
  const file = id3(3, [
    text23('TIT2', 'Get Lucky'),
    text23('TPE1', 'Daft Punk'),
    text23('TALB', 'Random Access Memories'),
    text23('TYER', '2013'),
    text23('TRCK', '3/12'),
    text23('TCON', 'Electronic')
  ]);
  const t = extractTags(file);
  eq(t.title, 'Get Lucky', 'TIT2 becomes the title');
  eq(t.artist, 'Daft Punk', 'TPE1 becomes the artist');
  eq(t.album, 'Random Access Memories', 'TALB becomes the album');
  eq(t.year, '2013', 'TYER becomes the year');
  eq(t.track, '3', 'TRCK "3/12" keeps just the number');
  eq(t.genre, 'Electronic', 'TCON becomes the genre');
}

console.log('--- ID3v2.3, UTF-16 and multiple values ---');
{
  eq(extractTags(id3(3, [text23('TIT2', 'Café Tacvba', 1)])).title, 'Café Tacvba',
     'encoding 1 (UTF-16LE + BOM) decodes');
  eq(extractTags(id3(3, [text23('TIT2', 'Sigur Rós', 2)])).title, 'Sigur Rós',
     'encoding 2 (UTF-16BE) decodes');
  eq(extractTags(id3(3, [text23('TPE1', 'A\u0000B', 0)])).artist, 'A, B',
     'NUL-separated artists are kept as readable credits');
  eq(extractTags(id3(3, [text23('TIT2', '  Padded \u0000\u0000 ')])).title, 'Padded',
     'NUL padding and stray spaces are trimmed');
}

console.log('--- ID3v2.4 ---');
{
  const file = id3(4, [
    text24('TIT2', 'Jóga', 3),
    text24('TPE1', 'Björk', 3),
    text24('TDRC', '1997-09-22', 3),
    text24('TRCK', '3/10', 3)
  ]);
  const t = extractTags(file);
  eq(t.title, 'Jóga', 'v2.4 UTF-8 (encoding 3) decodes');
  eq(t.artist, 'Björk', 'synchsafe frame sizes are honoured');
  eq(t.year, '1997', 'TDRC date is cut down to the year');
  eq(t.track, '3', 'v2.4 track number');
}

console.log('--- ID3v2.2 ---');
{
  const file = id3(2, [
    frame22('TT2', id3Text('Blue Monday', 0)),
    frame22('TP1', id3Text('New Order', 0)),
    frame22('TAL', id3Text('Power, Corruption & Lies', 0)),
    frame22('TYE', id3Text('1983', 0)),
    frame22('TRK', id3Text('1', 0))
  ]);
  const t = extractTags(file);
  eq(t.title, 'Blue Monday', 'v2.2 TT2 becomes the title');
  eq(t.artist, 'New Order', 'v2.2 TP1 becomes the artist');
  eq(t.album, 'Power, Corruption & Lies', 'v2.2 TAL becomes the album');
  eq(t.year, '1983', 'v2.2 TYE becomes the year');
  eq(t.track, '1', 'v2.2 TRK becomes the track');
}

console.log('--- ID3v2 quirks ---');
{
  // v2.3 extended header: 4-byte size (excluding itself) + 2 flags + 4 padding.
  const ext = cat(be32(6), [0, 0], be32(0));
  const withExt = id3(3, [cat(ext, text23('TIT2', 'Guarded'))], 0x40);
  eq(extractTags(withExt).title, 'Guarded', 'a v2.3 extended header is skipped');

  const ext4 = cat(synchsafe(6), [1, 0]);         // v2.4: size includes itself (4+1+1)
  const withExt4 = id3(4, [cat(ext4, text24('TIT2', 'Guarded 4'))], 0x40);
  eq(extractTags(withExt4).title, 'Guarded 4', 'a v2.4 extended header is skipped');

  // Unsynchronisation: the flag is set and every 0xFF is followed by 0x00.
  const raw = cat(ascii('ID3'), [3, 0, 0x80], synchsafe(0), []);
  const frames = text23('TIT2', 'A\u00ffB');
  const size = frames.length + frames.filter((b) => b === 0xff).length;
  const un = cat(ascii('ID3'), [3, 0, 0x80], synchsafe(size), unsync(frames));
  eq(extractTags(un).title, 'A\u00ffB', 'unsynchronised tag bodies are de-unsynced');
  ok(extractTags(raw) !== null, 'an empty unsynchronised tag does not throw');

  // A tag whose declared size runs past the buffer still yields what is there.
  const truncated = id3(3, [text23('TIT2', 'Cut Short')], 0, 4096);
  eq(extractTags(truncated).title, 'Cut Short', 'a truncated tag parses what it has');

  // Frames can appear in any order; the first value for a key wins.
  const twice = id3(3, [text23('TIT2', 'First'), text23('TIT2', 'Second')]);
  eq(extractTags(twice).title, 'First', 'the first value for a key wins');
}

console.log('--- one pass gives art and tags together ---');
{
  const file = id3(3, [
    text23('TIT2', 'Windowlicker'),
    frame23('APIC', apic('image/jpeg', 'cover', JPEG, 3)),
    text23('TPE1', 'Aphex Twin')
  ]);
  const tags = extractTags(file);
  const art = extractArt(file);
  eq(tags.title, 'Windowlicker', 'text before the picture survives');
  eq(tags.artist, 'Aphex Twin', 'text after the picture survives too');
  ok(art && art.mime === 'image/jpeg', 'the picture is still found in the same pass');
  eq(art.bytes.length, JPEG.length, 'the picture bytes are intact');
}

/* ------------------------------------------------------------------ */
/* FLAC                                                                */
/* ------------------------------------------------------------------ */

console.log('--- FLAC Vorbis comments ---');
{
  const comments = vorbis([
    'TITLE=Jóga', 'ARTIST=Björk', 'ALBUM=Homogenic', 'DATE=1997',
    'TRACKNUMBER=3', 'GENRE=Electronic', 'UNRELATED=ignored'
  ]);
  const file = flac([flacBlock(4, false, comments), flacBlock(6, true, flacPicture('image/jpeg', JPEG))]);
  const t = extractTags(file);
  eq(t.title, 'Jóga', 'TITLE is read from a little-endian comment block');
  eq(t.artist, 'Björk', 'ARTIST is read');
  eq(t.album, 'Homogenic', 'ALBUM is read');
  eq(t.year, '1997', 'DATE becomes the year');
  eq(t.track, '3', 'TRACKNUMBER becomes the track');
  eq(t.genre, 'Electronic', 'GENRE is read');
  eq(t.UNRELATED, undefined, 'unknown keys are ignored');
  ok(extractArt(file) !== null, 'the PICTURE block still yields art');
}

console.log('--- FLAC details ---');
{
  const multi = flac([flacBlock(4, true, vorbis(['ARTIST=Björk', 'ARTIST=Thom Yorke']))]);
  const t = extractTags(multi);
  eq(t.artist, 'Björk, Thom Yorke', 'multiple ARTIST lines are joined');

  const dup = flac([flacBlock(4, true, vorbis(['TITLE=One', 'TITLE=Two']))]);
  eq(extractTags(dup).title, 'One', 'a repeated TITLE keeps the first');

  const lower = flac([flacBlock(4, true, vorbis(['title=lower case key']))]);
  eq(extractTags(lower).title, 'lower case key', 'comment keys are case-insensitive');

  const albumOnly = flac([flacBlock(4, true, vorbis(['ALBUM=No Name']))]);
  const a = extractTags(albumOnly);
  eq(a.album, 'No Name', 'an album without a title is still reported');
  eq(a.title, undefined, 'and leaves the title absent');

  const cut = flac([flacBlock(4, true, cat(le32(20), []))]);
  ok(extractTags(cut) && !extractTags(cut).title, 'a comment block that runs short parses nothing and does not throw');
}

/* ------------------------------------------------------------------ */
/* MP4                                                                 */
/* ------------------------------------------------------------------ */

console.log('--- MP4 ilst atoms ---');
{
  const file = mp4([
    [NAM, dataAtom(1, u8('Teardrop', 'utf8'))],
    [ART, dataAtom(1, u8('Massive Attack', 'utf8'))],
    [ALB, dataAtom(1, u8('Mezzanine', 'utf8'))],
    [DAY, dataAtom(1, u8('1998-04-20', 'utf8'))],
    [GEN, dataAtom(1, u8('Trip-Hop', 'utf8'))],
    ['trkn', dataAtom(0, [0, 0, 0, 4, 0, 12, 0, 0])],
    ['covr', dataAtom(13, JPEG)]
  ]);
  const t = extractTags(file);
  eq(t.title, 'Teardrop', '\u00a9nam becomes the title');
  eq(t.artist, 'Massive Attack', '\u00a9ART becomes the artist');
  eq(t.album, 'Mezzanine', '\u00a9alb becomes the album');
  eq(t.year, '1998', '\u00a9day becomes the year');
  eq(t.genre, 'Trip-Hop', '\u00a9gen becomes the genre');
  eq(t.track, '4', 'binary trkn becomes the track number');
  ok(extractArt(file) !== null, 'covr still yields art');
}

console.log('--- MP4 details ---');
{
  const utf16 = mp4([[NAM, dataAtom(2, cat([0xfe, 0xff], utf16be('Fake Plastic Trees')))]]);
  eq(extractTags(utf16).title, 'Fake Plastic Trees', 'UTF-16 data atoms decode');

  // Repeated values inside one entry, which is how writers store them.
  const multi = mp4([[ART, cat(dataAtom(1, u8('One', 'utf8')), dataAtom(1, u8('Two', 'utf8')))]]);
  eq(extractTags(multi).artist, 'One, Two', 'multiple data atoms are joined');

  const albumArtist = mp4([['aART', dataAtom(1, u8('Various Artists', 'utf8'))]]);
  eq(extractTags(albumArtist).albumArtist, 'Various Artists', 'aART is read as the album artist');

  const empty = mp4([[NAM, dataAtom(1, [])]]);
  ok(extractTags(empty) && !extractTags(empty).title, 'an empty data atom adds nothing');

  const trailer = cat(mp4([[NAM, dataAtom(1, u8('Zero Size', 'utf8'))]]), [0, 0, 0, 0]);
  eq(extractTags(trailer).title, 'Zero Size', 'a zero-sized box at the end does not stop the walk');

  const notMp4 = cat(ascii('wxyz'), [0, 0, 0, 16], ascii('junk'));
  const t = extractTags(notMp4);
  ok(t && Object.keys(t).length === 0, 'a non-MP4 file yields no tags');
}

/* ------------------------------------------------------------------ */
/* never throws                                                        */
/* ------------------------------------------------------------------ */

console.log('--- inputs it must survive ---');
{
  const junk = new Uint8Array(64);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) & 0xff;

  // A corrupt tag: a valid header whose first frame claims an absurd size.
  const absurd = cat(ascii('ID3'), [3, 0, 0], synchsafe(1024), ascii('TIT2'), be32(0xfffffff0), [0, 0]);
  // A frame id with junk in it, which ends the walk.
  const badId = cat(ascii('ID3'), [3, 0, 0], synchsafe(20), ascii('TI!2'), be32(4), [0, 0], [0, 1, 2, 3]);

  const t = extractTags(junk);
  ok(t && Object.keys(t).length === 0, 'random bytes yield no tags');
  ok(Object.keys(extractTags(new Uint8Array(absurd))).length === 0, 'an absurd frame size ends the walk cleanly');
  ok(Object.keys(extractTags(badId)).length === 0, 'a malformed frame id ends the walk cleanly');

  const inputs = [null, undefined, 0, 42, '', 'not bytes', {}, [], new Uint8Array(0),
                  new ArrayBuffer(0), [1, 2, 3], { length: 4, 0: 1, 1: 2, 2: 3, 3: 4 }];
  let threw = null;
  for (const input of inputs) {
    try { parseMediaTags(input); } catch (e) { threw = String(e && e.message) + ' on ' + JSON.stringify(input); }
  }
  ok(threw === null, 'no input shape makes it throw', threw);
  eq(parseMediaTags(new Uint8Array(0)), null, 'empty input returns null, not an empty tag set');
  eq(extractTags(null), null, 'and the tag reader passes that through');
  eq(extractArt(null), null, 'as does the art reader');
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILURE(S)') + '  (' + (pass + fail) + ' assertions)');
process.exit(fail === 0 ? 0 : 1);
