# visualise

A now-playing dashboard for your whole computer. It listens to whatever the
machine is outputting, reads the track from MPRIS, and draws it: large cover
art on the left (sleeve or spinning vinyl), a full-width analyser on the right,
the track name underneath, and real transport controls. Nothing to import.

## Run it

```sh
python3 serve.py
```

It starts `http://127.0.0.1:8765/` and opens your browser (`--no-open` to
skip, `--port N` to move it). The page cannot capture system audio on its own,
so a small standard-library helper does the work — no dependencies, no build
step, and it binds to loopback only.

Requirements: Python 3.8+, PipeWire or PulseAudio (`parec`, `pactl`), and
`playerctl` for metadata and transport. Missing pieces degrade quietly: no
capture still shows the track and art; no playerctl still visualises the audio.

## How it works

- **Capture** — `parec` records the default sink's monitor source as raw
  stereo `s16le`; the helper streams it over chunked HTTP. The page feeds it
  through an `AudioWorklet` ring buffer into an `AnalyserNode`. Your audio is
  already audible, so the page only listens *visually*: the graph ends in a
  gain of zero.
- **Now playing** — `/api/state` reads MPRIS through `playerctl`. A playing
  player always wins; when everything is paused the last-active player stays
  selected, so two paused players don't fight over the page.
- **Transport** — `/api/control` does play/pause, next, previous and seek
  against the selected player.
- **Cover art** — proxied through `/api/art?url=…`. Serving it same-origin is
  what makes the pixels readable for colour extraction; it handles `http(s)`
  art and the `file://` art that browsers (Firefox) publish.
- **Colour** — the dominant colour of the cover drenches the background and
  pulses on beats. Text ink is picked for that colour and the mix is backed off
  until *every* text token clears WCAG AA (4.5:1) — no cover can make the text
  unreadable. Measured worst case over 28 cover/base pairs: 4.58:1.
- **Art** — Sleeve or Vinyl, remembered in `localStorage`. The vinyl spins at
  1.8s/rev (33⅓ rpm) while playing, with grooves, a sheen and a spindle hole.
- **Beat** — bass-onset detection drives the background pulse, a ring, and a
  small scale on the art. Honours `prefers-reduced-motion`.
- **Fallbacks** — drop an audio file anywhere on the page to play it locally
  (it becomes audible and is analysed in place). MusicBrainz is queried only
  when the player supplies no art at all.

## Controls

| | |
|---|---|
| <kbd>Space</kbd> | play / pause |
| <kbd>←</kbd> <kbd>→</kbd> | seek 5s |
| click the bar | scrub |

Status line tells you what's happening: `spotify · Playing`, or
`click anywhere to start listening` (browsers hold a fresh `AudioContext`
suspended until the page sees a gesture), or
`helper offline — run: python3 serve.py` if you opened the file directly.

## Test flags

`?debug=1` mirrors live state into `<html data-viz>` — frames, audio level,
peak, PCM chunks received, source, art mode, and the computed background/ink.
Useful in DevTools; used by the tests. `?capture=0` skips the audio stream and
`?art=vinyl` preselects the art mode, both for deterministic screenshots.

## Tests

```sh
node tests/pure.test.js      # colour/contrast engine, matching, parsing (33)
node tests/worklet.test.js   # PCM ring-buffer processor (16)
```

Both extract the real functions out of `index.html`, so they test what ships.
