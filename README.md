# visualise

A small, dependency-free music visualiser. Drop in a song (or use your
microphone) and watch bars, waves, and beat rings react to the audio.

Open `index.html` in a browser — no build step, no server needed.

## Features

- **Any song works** — the visuals come straight from the audio's FFT
  (Web Audio API `AnalyserNode`), so nothing is timed by hand.
- **Bars mode** — 48 log-spaced frequency bars with eased smoothing and
  falling peak caps.
- **Waveform mode** — oscilloscope view of the raw wave.
- **Beat detection** — a rolling low-end average spots kicks and kicks a
  ring + colour pulse across the tile and page.
- **Track identification** — loads are looked up on MusicBrainz (keyless,
  one request, cached); a confident match swaps the live mini-eq thumbnail
  for real cover art from the Cover Art Archive.
- **Service links** — one click to search the current track on Spotify or
  YouTube Music.
- **Tile-player UI** — seekable progress bar, volume, mic input with a LIVE
  badge, keyboard controls (Space, arrows), drag-and-drop, dark mode via
  system preference.

## File naming

Name files `Artist - Title.ext` and the identification + service links
improve automatically. Anything else falls back to a title-only lookup.
