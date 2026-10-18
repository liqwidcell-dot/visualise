# visualise

A now-playing dashboard for whatever your machine is playing: large cover art on
one side (sleeve or spinning vinyl), a full-width analyser filling the rest, the
track name underneath, and the cover's dominant colour drenching the background
and pulsing on beats.

**No install, no build, no helper.** One HTML file, standard browser APIs only.

**Live demo:** <https://liqwidcell-dot.github.io/visualise/>

## Using it

1. Play something in a browser tab.
2. Click **Capture what's playing** and pick that tab, with *Also share tab
   audio* ticked.
3. Type the artist and title into the field that appears. Cover art, its colour
   and the service links follow from that name — a web page cannot read another
   app's metadata, so the page asks rather than guesses.

Nothing to play? Drop an audio file anywhere on the page: it plays locally, the
analyser runs on it, and its own tags are read straight from the bytes — title,
artist, album, year, track and genre, plus any embedded cover art. A file whose
name lies about its contents gets the right name from its tags (`Wrong Artist -
Wrong Title.mp3` shows what the tags say); a file with no tags falls back to the
`Artist - Title.mp3` convention and says so. Or add `?selftest=1` for a silent
synthetic tone that proves the meters move, with no permission needed.

## The helper edition

An earlier version needed a small local helper to hear the machine's own audio:
`serve.py` recorded the default sink's monitor source with `parec` and streamed
it in, read the track and transport from MPRIS with `playerctl`, and proxied
cover art so the canvas could read it. That is what made **system audio** —
everything the computer is playing — possible, and no browser can do it alone on
Linux.

It is kept, frozen and unmaintained, in [`with-helper/`](with-helper/): run
`python3 with-helper/serve.py`. This page is the zero-install one; that folder
is the other edition, with its own README.

## What it can capture

Capture is capability-driven, not user-agent sniffed — it tries the best route it
can actually get:

1. **Share a tab.** `getDisplayMedia` first: pick the tab that is playing. On
   Linux this is the only zero-install route to audio — Chromium can share *tab*
   audio, Firefox cannot share audio at all. The share's video track is kept
   alive but never drawn, which is what keeps the browser's own "Stop sharing"
   bar working, and its `ended` event is how the page notices sharing stopped.
   Echo cancellation, noise suppression and auto gain are switched off: they are
   tuned for speech and mangle music.
2. **A loopback input.** If the share carries no audio track, the page looks for
   an input device whose name suggests a monitor or loopback (PipeWire,
   BlackHole, Stereo Mix, …). Stock Chromium filters monitor devices out of its
   picker, so this mainly helps Firefox or a virtual sink. Device labels only
   appear once microphone permission is granted, so the page asks once.
3. **An honest status message** when neither is available.

There is no microphone path: this is for visualising what is already playing, not
for listening to the room.

## Cover art and tags

- **Typed names** are looked up on the [iTunes Search
  API](https://performance-partners.apple.com/search-api) — keyless, CORS-open,
  artwork included. MusicBrainz/Cover Art Archive was dropped: archive.org sends
  no `Access-Control-Allow-Origin`, so the canvas would be tainted and the colour
  engine could never read the pixels.
- **Dropped files** carry their own art and their own names, and one pass over
  the bytes reads both: ID3v2 (`APIC`/`PIC`, `TIT2`/`TPE1`/`TALB`/`TYER`/…, v2.2
  through v2.4, utf-8/utf-16/latin-1), MP4 (`covr`, plus the `©nam`/`©ART`/…
  `ilst` atoms) and FLAC (`PICTURE`, plus Vorbis comments). Front cover wins,
  else the largest. Ogg is deliberately unsupported. This path is offline — no
  lookup.
- **Tags beat the filename.** A file tagged inside shows what the tags say, and
  the status line says where the name came from. Tags with no title or artist
  still fall back to the filename, and say that instead of pretending. Only when
  the file brings no art is the name looked up for one.
- A typed artist is never overwritten by a match; a bare title gets the matched
  artist filled in.
- Opened straight from disk (`file://`) browsers block the cross-origin lookup,
  so the page says so. Use the hosted copy, or any local web server, for art.

## Colour

The cover's dominant colour drenches the page and pulses on bass onsets. Ink is
chosen for each cover and the mix is backed off in steps until *every* text token
clears WCAG AA (4.5:1), so no cover can make the text unreadable — measured worst
case over 14 covers × 2 themes is 4.58:1. Honours `prefers-reduced-motion`.

## Controls

| | |
|---|---|
| **Capture what's playing** | pick a tab to listen to |
| **Stop capturing** | stop (the browser's own *Stop sharing* does too) |
| <kbd>Space</kbd> | play / pause a dropped file |
| <kbd>←</kbd> <kbd>→</kbd> | seek 5s in a file |
| click the bar | scrub |
| <kbd>Enter</kbd> in the name field | look up cover art |
| drop a file anywhere | play it locally |

## Debug flags

`?debug=1` mirrors live state into `<html data-viz>` — frames, level, peak,
source, art, art mode, background/ink, the last lookup, the tags read from a
dropped file and the status line. It is how the tests read the page and it is
handy in DevTools. `?q=Artist+-+Title` pre-fills and resolves the identity
field, and `?selftest=1` pushes a silent synthetic tone through the real capture
path. All three are for deterministic screenshots and checks.

## Tests

```sh
node tests/pure.test.js          # colour/contrast engine, name matching, parsing
node tests/embedded-art.test.js  # embedded cover art, every supported format
node tests/file-tags.test.js     # dropped-file tags: ID3v2.2/2.3/2.4, FLAC, MP4
```

Plain `node`, no dependencies and no `package.json` — 179 assertions across the
three suites. Each pulls the real functions out of `index.html` by brace matching
(`tests/extract.js`) instead of keeping copies, so they test exactly what ships.
`pure.test.js` ends with one live iTunes call and skips it when offline.

## Files

`index.html` is the whole product: markup, design tokens, styling and script.
`tests/` holds the three suites and the shared extractor. `with-helper/` holds
the frozen earlier edition that needed the Python helper. The working journal is
deliberately not in this repo.
