# Visualise — helper edition

The earlier version of Visualise: the one that needed a small local helper to
hear the machine's own audio. It is kept here, frozen, because it is still the
only variant that can visualise **system audio** — everything the computer is
playing, not just one browser tab.

**This is not the live build.** The current, zero-install version is the page at
the repository root: <https://liqwidcell-dot.github.io/visualise/> — one HTML
file, no Python, no install of any kind. Everything below applies to this folder
only.

## Run it

```sh
python3 serve.py
```

It starts `http://127.0.0.1:8765/` and opens your browser (`--no-open` to skip
that, `--port N` to move it). Standard library only: no dependencies, no build
step, loopback only.

Requirements: Python 3.8+, PipeWire or PulseAudio (`parec`, `pactl`), and
`playerctl` for the track name, art and transport controls. Missing pieces
degrade quietly — no capture still shows the track and art, no `playerctl` still
visualises the audio.

## What the helper was for

`serve.py` did the three jobs a web page cannot do for itself:

- **Audio** — recorded the default sink's monitor source with `parec` and handed
  it to the page as raw s16le PCM, fed through an `AudioWorklet` ring buffer.
- **Metadata and transport** — read the playing track from MPRIS with
  `playerctl`, and drove play/pause/next/seek through it.
- **Cover art** — proxied artwork over the same origin, so the canvas could read
  the pixels for the colour engine without being tainted.

The requirement then became "no install of any kind". On Linux no browser can
capture the system mix, so the current version shares a **Chromium tab** instead
and the track name is typed in. That trade is the entire difference between the
two editions.

## What's in here

| file | what it is |
|---|---|
| `index.html` | the whole page for this edition |
| `serve.py` | the helper: PCM stream, MPRIS state, transport, art proxy |
| `tests/worklet.test.js` | test for the PCM ring buffer (`node tests/worklet.test.js`) |

All three are byte-for-byte the versions from the last commit that had them
(`8ce07e7`, "README: point at the hosted demo and what it can't do"); nothing
here is maintained afterwards, and nothing here is imported by the root page.

<https://liqwidcell-dot.github.io/visualise/with-helper/> serves this page as
well. There it reports "helper offline", exactly as it always did — GitHub Pages
cannot spawn `parec` or reach MPRIS — and dropping an audio file on it still
runs the analyser.
