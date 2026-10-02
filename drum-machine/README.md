# Drum Machine

A browser-based drum machine and step sequencer built on the Web Audio API. It's plain TypeScript
built with Vite and has no runtime dependencies. It lives in its own directory and is independent
of the D code in the rest of this repository.

## Run it

```sh
cd drum-machine
npm install
npm run dev        # http://localhost:5173
npm run build      # static production build in dist/ (works from any path, base: './')
npm run preview    # serve the production build
```

## Features

- **Sequencer**: 7 tracks (kick, snare, closed hat, open hat, clap, rimshot, tom). Sections A–D
  each have their own pattern and length (8–64 steps; 16 by default, 32 = two bars).
  - Steps can be off, on, or accented.
  - The grid shows beat and bar groupings, the audible step, and a per-track hit LED.
- **Transport**: play, pause, stop, return to start.
  - Tempo is 40–240 BPM, set by number field, slider or ±1 nudges.
  - Swing is 50–75%. 50% is straight; it delays every second 16th note.
  - Bar/beat/16th position read-out and master volume, with a limiter on the master bus.
  - Switching sections while playing is queued until the current section ends.
- **Mixer**: volume, pan, mute and solo per track.
- **Sound editor** (per track):
  - sample selection
  - pitch in semitones plus fine tuning in cents
  - attack and decay
  - sample start/end points, shown on the waveform
  - pitch envelope (amount and time)
  - tone (dark/low-pass ↔ thin/high-pass)
  - choke groups (the closed hat chokes the open hat by default)
  - audition button, optional audition on edit, and reset to defaults
- **Custom samples**:
  - Import with a file picker or by dropping a file on a track row or the editor.
  - The file is decoded and previewed (name, duration, size, waveform) before you assign it.
  - Assigned samples can be replaced, removed, or deleted from the library.
- **Patterns**: save, load, rename, duplicate and delete named patterns. Start blank or restore the
  four example patterns. Export/import JSON, optionally with the custom samples embedded. The
  working session is autosaved and restored on refresh.
- **Keyboard**:

  | Key | Action |
  | --- | --- |
  | Space | play/pause |
  | Esc | stop |
  | Home | return to start |
  | 1–4 | select section |
  | Arrow keys | move in the grid |
  | Enter / Space | toggle the focused step |
  | A | accent the focused step |
  | Ctrl/⌘+S | save |

  The `?` button in the header lists the shortcuts.

## Audio engine and timing

- **Lookahead scheduling ("two clocks").** A timer wakes every 25 ms and schedules every step that
  falls within the next 120 ms. Each hit is started with `AudioBufferSourceNode.start(when)` at an
  exact `AudioContext` time, so playback never depends on when the JavaScript timer fires.
  - The timer runs in a dedicated Web Worker, because browsers throttle main-thread timers in
    background tabs. If Workers are unavailable it falls back to `setInterval`.
  - While the tab is hidden the lookahead grows to 1 s.
- **No drift.** Step times are computed from an anchor (`anchorTime + n × stepDuration`) rather than
  by repeatedly adding durations.
  - Swing only offsets odd 16ths, so the beat grid is never moved.
  - A tempo change re-anchors at the next unscheduled step. Steps already scheduled (≤120 ms ahead)
    keep their timing, so the change is continuous and predictable.
  - If the timer is starved for longer than the lookahead (for example by a frozen tab), the
    timeline is shifted forward instead of playing a burst of late notes.
- **Transport safety.**
  - Play is idempotent: there is only ever one scheduler loop.
  - Every play, pause, stop or rewind bumps a generation counter, so a late timer message from an
    old loop is ignored.
  - Pause and stop cancel pending voices that were scheduled but haven't started. Stop also fades
    out voices that are still ringing.
  - Pause resumes from the first step that had not yet been heard.
- **AudioContext lifecycle.**
  - The context is created lazily and resumed from the Play/Audition click (a user gesture).
  - If the browser or OS suspends or interrupts it (for example a phone call on iOS), playback
    pauses and a message explains how to continue.
  - A closed context is recreated on the next play.
- **Playhead sync.** On each animation frame the grid shows the step whose scheduled time is
  `≤ currentTime − outputLatency`. It is derived from the same events that drove the audio, not
  from a separate timer.
- **Resources.**
  - Channel strips (filter → panner → gain) and the master bus are created once.
  - Each hit creates one `AudioBufferSourceNode` and one envelope `GainNode`. Both are disconnected
    when the voice ends or is cancelled, and muted tracks are not scheduled at all.

### Browser limitations that cannot be fully eliminated

- Browsers require a user gesture before audio can start. Nothing plays until you press Play or
  Audition once.
- Changes to steps, tempo or mute reach the audio within one lookahead window: ~120 ms normally,
  up to ~1 s while the tab is hidden.
- `outputLatency` is not reported by every browser (Safari reports `baseLatency` only). On
  Bluetooth headphones the playhead may appear slightly early.
- Background tabs, especially on mobile, can be suspended entirely by the OS. Playback then pauses
  and must be resumed by the user.
- **Tuning changes duration.** Pitch is changed through `playbackRate`, like a classic sampler:
  lower pitches play longer and higher pitches shorter. The pitch envelope works the same way.
  Pitch-preserving time-stretching is not implemented, because it is impractical for real-time
  one-shots and smears drum transients.

## Samples and persistence

- **Default kit.** The built-in sounds (two kicks, two snares, closed/open hats, two claps, rimshot,
  cowbell, three toms) are synthesized in JavaScript when the app starts (`src/audio/synth.ts`).
  - They are original sounds generated by this code. There are no third-party recordings, no
    licensing obligations, and no network requests, so there are no CORS issues.
- **Imported samples.** Anything the browser can decode is accepted: WAV, MP3, OGG/Opus, FLAC,
  AAC/M4A, WebM, AIFF (Safari), and so on.
  - Limits: 20 MB per file and 30 s of audio.
  - Empty files, non-audio files, undecodable or corrupted data, and oversized files are rejected
    with a message. Nothing is stored until you press Assign.
- **Storage.** Everything stays in the browser's IndexedDB:
  - the working session (autosaved)
  - saved patterns
  - imported samples, kept as the original file bytes and decoded again on load
  - sample metadata, kept in a separate store so listing samples never loads audio
- **Nothing is uploaded.** No data leaves the browser.
- **Fallbacks.** If IndexedDB is unavailable (some private windows), the app runs from memory and
  says so.
- **Data validation.** Imported JSON and stored data are validated on load.
  - Fatal problems (not an object, newer format version, no sections) are rejected.
  - Out-of-range or wrongly typed values are clamped or repaired, with a warning.
  - A corrupted saved pattern is listed as such and can still be deleted.
  - Missing sample references fall back to the track's default sound.

## Tests

| Command | What it runs |
| --- | --- |
| `npm test` | **Unit tests** (Vitest + jsdom): timing math, scheduler/transport, audio engine, samples and file validation, data validation, storage, controller, DOM UI. Real IndexedDB code runs against `fake-indexeddb`. |
| `npm run test:e2e` | **Browser integration tests** (Playwright, Chromium desktop + mobile emulation). Builds and serves the app; uses a real AudioContext, IndexedDB and decoder. Covers the playhead, scheduling, persistence, keyboard, library, WAV import and JSON export/import. |
| `npm run check` | Typecheck + lint + unit tests + production build. |

- **Unit tests** use the deterministic fakes in `tests/unit/fakes.ts`: a fake AudioContext that
  records scheduled times, parameter automation and connections, and a manually driven ticker.
  They prove the scheduling logic produces the right timestamps. They do not prove anything about
  real-browser timing or sound.
- **Browser tests** check, against the real Chromium audio clock, that:
  - every hit is scheduled before its playback time
  - consecutive hits are exactly one step apart, including across a tempo change
  - the drawn playhead matches the audible step
  
  They do not listen to the output.

### Manual audio checks (not automated)

Run these by ear in each target browser:

1. Play the House Groove at 124 BPM for a minute and listen for flams, drift or dropouts. Then
   switch to another tab for 30 s and come back.
2. Turn swing from 50% to 66%. The off-beat hats should shuffle while the kick stays on the beat.
3. Drag the tempo slider while playing. The tempo should change smoothly, without stutter.
4. Raise and lower kick pitch by ±12 st, shorten the decay, and add a pitch envelope. Each change
   should be audible and free of clicks.
5. Play open hat then closed hat. The closed hat should cut the open hat.
6. Import a WAV and an MP3 and audition them. Move the start/end points and listen for the change.

## Code layout

```
src/
  model/       types, defaults, example patterns, validation of stored/imported data
  sequencer/   timing math, lookahead scheduler/transport, worker ticker
  audio/       Web Audio engine, synthesized default kit, sample import helpers
  storage/     IndexedDB backend (+ in-memory fallback)
  controller.ts  app state and actions tying sequencer, engine and storage together
  ui/          DOM views (transport, grid, mixer, editor, library, toasts)
tests/unit/    Vitest suites + Web Audio fakes
tests/e2e/     Playwright suites
```
