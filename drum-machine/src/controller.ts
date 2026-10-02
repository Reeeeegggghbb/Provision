import { AudioEngine, velocityFor } from './audio/engine';
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  computePeaks,
  loadSampleFile,
  newId,
  validateDecoded,
  type PendingSample,
} from './audio/samples';
import { BUILTIN_SOUNDS, isBuiltin, renderBuiltin, SYNTH_SAMPLE_RATE } from './audio/synth';
import { blankPattern, cloneDoc, DEFAULT_SAMPLE, defaultTrackSound, resizeSteps } from './model/defaults';
import { examplePatterns } from './model/examples';
import {
  BPM_MAX,
  BPM_MIN,
  MAX_LENGTH,
  MIN_LENGTH,
  SECTION_COUNT,
  SWING_MAX,
  SWING_MIN,
  TRACK_IDS,
  TRACK_LABELS,
  type PatternDoc,
  type SampleMeta,
  type SavedPatternRecord,
  type StepValue,
  type TrackId,
  type TrackSound,
} from './model/types';
import {
  clamp,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  parseJson,
  validateExportFile,
  validatePatternDoc,
  type ExportFile,
} from './model/validate';
import { Sequencer, type StepEvent, type TransportState } from './sequencer/sequencer';
import type { Ticker } from './sequencer/ticker';
import type { StorageBackend } from './storage/storage';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface SavedPatternEntry {
  id: string;
  name: string;
  updatedAt: number;
  corrupt: boolean;
}

export interface PendingImport {
  track: TrackId;
  sample: PendingSample;
}

export interface State {
  doc: PatternDoc;
  currentPatternId: string | null;
  dirty: boolean;
  selectedTrack: TrackId;
  transport: TransportState;
  queuedSection: number | null;
  audioState: string;
  samples: SampleMeta[];
  brokenSamples: Set<string>;
  savedPatterns: SavedPatternEntry[];
  pending: PendingImport | null;
  importing: boolean;
  persistent: boolean;
}

export interface ControllerDeps {
  engine: AudioEngine;
  storage: StorageBackend;
  ticker: Ticker;
  autosaveDelayMs?: number;
  now?: () => number;
}

export interface Playhead {
  section: number;
  step: number;
  time: number;
}

const EXAMPLE_PREFIX = 'example-';

export class Controller {
  readonly engine: AudioEngine;
  readonly storage: StorageBackend;
  readonly sequencer: Sequencer;
  state: State;
  private listeners = new Set<(s: State) => void>();
  private toastListeners = new Set<(msg: string, kind: ToastKind) => void>();
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveDelay: number;
  private playToken = 0;
  private peaksCache = new Map<string, Float32Array>();
  private wallNow: () => number;

  constructor(deps: ControllerDeps) {
    this.engine = deps.engine;
    this.storage = deps.storage;
    this.autosaveDelay = deps.autosaveDelayMs ?? 400;
    this.wallNow = deps.now ?? (() => Date.now());
    const doc = blankPattern();
    this.state = {
      doc,
      currentPatternId: null,
      dirty: false,
      selectedTrack: 'kick',
      transport: 'stopped',
      queuedSection: null,
      audioState: 'uninitialised',
      samples: [],
      brokenSamples: new Set(),
      savedPatterns: [],
      pending: null,
      importing: false,
      persistent: deps.storage.persistent,
    };
    this.sequencer = new Sequencer(
      {
        clock: { now: () => this.engine.currentTime },
        ticker: deps.ticker,
        sectionLength: (i) => this.state.doc.sections[i]?.length ?? 16,
        onSchedule: (ev) => this.scheduleStep(ev),
        onCancel: (t, mode) => this.engine.cancelFrom(t, mode === 'stop'),
        onStateChange: (s) => {
          this.state.transport = s;
          this.syncSectionFromSequencer();
          this.emit();
        },
      },
      { bpm: doc.bpm, swing: doc.swing },
    );
    this.engine.onStateChange = (s) => this.handleAudioState(s);
  }

  // ---------------------------------------------------------------- events

  subscribe(fn: (s: State) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onToast(fn: (msg: string, kind: ToastKind) => void): () => void {
    this.toastListeners.add(fn);
    return () => this.toastListeners.delete(fn);
  }

  toast(msg: string, kind: ToastKind = 'info'): void {
    for (const fn of this.toastListeners) fn(msg, kind);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  /** Apply a doc mutation, mark dirty, schedule an autosave and notify views. */
  private change(mutate: (doc: PatternDoc) => void, opts: { mix?: boolean } = {}): void {
    mutate(this.state.doc);
    this.state.dirty = true;
    if (opts.mix) this.engine.applyMix(this.state.doc.tracks);
    this.scheduleAutosave();
    this.emit();
  }

  private scheduleAutosave(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => void this.saveSession(), this.autosaveDelay);
  }

  async saveSession(): Promise<void> {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    try {
      await this.storage.putSession({
        doc: this.state.doc,
        currentPatternId: this.state.currentPatternId,
        selectedTrack: this.state.selectedTrack,
        dirty: this.state.dirty,
      });
    } catch {
      this.toast('Could not save your session to browser storage.', 'error');
    }
  }

  // ---------------------------------------------------------------- start-up

  /** Load samples, saved patterns and the last session from storage. */
  async init(): Promise<void> {
    let metas: SampleMeta[] = [];
    try {
      metas = await this.storage.listSampleMeta();
    } catch {
      this.toast('Could not read saved samples.', 'error');
    }
    this.state.samples = metas.sort((a, b) => a.name.localeCompare(b.name));
    if (metas.length) {
      this.engine.ensureContext();
      await Promise.all(metas.map((m) => this.loadStoredSample(m.id)));
    }

    await this.refreshPatternList();

    let restored = false;
    let raw: unknown;
    try {
      raw = await this.storage.getSession();
    } catch {
      raw = undefined;
    }
    if (raw !== undefined) {
      const sess = raw as { doc?: unknown; currentPatternId?: unknown; selectedTrack?: unknown; dirty?: unknown };
      const result = validatePatternDoc(sess?.doc);
      if (result.ok) {
        this.setDoc(result.value);
        this.state.currentPatternId = typeof sess.currentPatternId === 'string' ? sess.currentPatternId : null;
        this.state.dirty = sess.dirty === true;
        if (TRACK_IDS.includes(sess.selectedTrack as TrackId)) this.state.selectedTrack = sess.selectedTrack as TrackId;
        restored = true;
        if (result.warnings.length) this.toast('Some saved settings were invalid and have been repaired.', 'warning');
      } else {
        this.toast('Your last session could not be restored (data was corrupted). Starting fresh.', 'warning');
      }
    }
    if (!restored) {
      if (this.state.savedPatterns.length === 0) await this.restoreExamples(false);
      const first = this.state.savedPatterns.find((p) => !p.corrupt);
      if (first) await this.loadPattern(first.id, false);
    }
    if (!this.state.persistent) {
      this.toast('Browser storage is unavailable — patterns and samples will not be kept after closing this tab.', 'warning');
    }
    this.emit();
  }

  private async loadStoredSample(id: string): Promise<void> {
    try {
      const rec = await this.storage.getSample(id);
      if (!rec) throw new Error('missing');
      const buffer = await this.engine.decode(rec.data);
      this.engine.setBuffer(id, buffer);
      this.peaksCache.set(id, computePeaks(buffer, 400));
    } catch {
      this.state.brokenSamples.add(id);
      this.toast('A stored sample could not be decoded and will be replaced by the default sound.', 'warning');
    }
  }

  private setDoc(doc: PatternDoc): void {
    // Any sample reference that cannot be resolved falls back to the track default.
    const missing: string[] = [];
    for (const t of TRACK_IDS) {
      const id = doc.tracks[t].sampleId;
      const known = isBuiltin(id) || (this.state.samples.some((s) => s.id === id) && !this.state.brokenSamples.has(id));
      if (!known) {
        doc.tracks[t].sampleId = DEFAULT_SAMPLE[t];
        missing.push(TRACK_LABELS[t]);
      }
    }
    if (missing.length) {
      this.toast(`Missing samples on ${missing.join(', ')} were replaced with the default sounds.`, 'warning');
    }
    this.state.doc = doc;
    this.sequencer.selectSection(doc.activeSection);
    this.sequencer.setTempo(doc.bpm);
    this.sequencer.setSwing(doc.swing);
    this.engine.setMasterVolume(doc.masterVolume);
    this.engine.applyMix(doc.tracks);
  }

  // ---------------------------------------------------------------- transport

  private scheduleStep(ev: StepEvent): void {
    const doc = this.state.doc;
    const section = doc.sections[ev.section];
    if (!section) return;
    const anySolo = TRACK_IDS.some((t) => doc.tracks[t].solo);
    for (const t of TRACK_IDS) {
      const v = section.steps[t][ev.step];
      if (!v) continue;
      const sound = doc.tracks[t];
      if (sound.mute || (anySolo && !sound.solo)) continue;
      this.engine.trigger(t, sound, ev.time, velocityFor(v));
    }
  }

  /** Start playback. Must be invoked from a user gesture so the AudioContext may resume. */
  async play(): Promise<boolean> {
    if (this.sequencer.state === 'playing') return false;
    const token = ++this.playToken;
    const state = await this.engine.resume();
    this.state.audioState = state;
    if (token !== this.playToken) return false; // stop/pause pressed while resuming
    if (state !== 'running') {
      this.toast('Audio could not start. Click Play again, or check that this tab is allowed to play sound.', 'error');
      this.emit();
      return false;
    }
    this.engine.setMasterVolume(this.state.doc.masterVolume);
    this.engine.applyMix(this.state.doc.tracks);
    return this.sequencer.play();
  }

  pause(): void {
    this.playToken++;
    this.sequencer.pause();
    this.emit();
  }

  stop(): void {
    this.playToken++;
    this.sequencer.stop();
    this.syncSectionFromSequencer();
    this.emit();
  }

  async togglePlay(): Promise<void> {
    if (this.sequencer.state === 'playing') this.pause();
    else await this.play();
  }

  rewind(): void {
    this.sequencer.rewind();
    this.emit();
  }

  /** Called on animation frames: the step currently audible, or null. */
  playhead(): Playhead | null {
    if (this.sequencer.state !== 'playing') return null;
    const t = this.engine.currentTime - this.engine.outputLatency;
    const ev = this.sequencer.eventAt(t);
    if (!ev) return null;
    if (ev.section !== this.state.doc.activeSection) {
      this.state.doc.activeSection = ev.section;
      this.state.queuedSection = this.sequencer.queuedSection;
      this.emit();
    }
    return { section: ev.section, step: ev.step, time: ev.time };
  }

  private syncSectionFromSequencer(): void {
    this.state.queuedSection = this.sequencer.queuedSection;
    if (this.sequencer.state !== 'playing') this.state.doc.activeSection = this.sequencer.section;
  }

  private handleAudioState(s: string): void {
    this.state.audioState = s;
    if (s !== 'running' && this.sequencer.state === 'playing') {
      this.sequencer.pause();
      this.toast('Audio was interrupted by the browser or system. Press Play to continue.', 'warning');
    }
    this.emit();
  }

  /** Background tabs get throttled timers; schedule further ahead while hidden. */
  setHidden(hidden: boolean): void {
    this.sequencer.setLookahead(hidden ? 1.0 : 0.12);
  }

  setBpm(bpm: number): void {
    const v = Math.round(clamp(bpm, BPM_MIN, BPM_MAX) * 10) / 10;
    if (!Number.isFinite(v)) return;
    this.sequencer.setTempo(v);
    this.change((d) => (d.bpm = v));
  }

  setSwing(swing: number): void {
    const v = clamp(swing, SWING_MIN, SWING_MAX);
    if (!Number.isFinite(v)) return;
    this.sequencer.setSwing(v);
    this.change((d) => (d.swing = v));
  }

  setMasterVolume(v: number): void {
    const vol = clamp(v, 0, 1.5);
    this.engine.setMasterVolume(vol);
    this.change((d) => (d.masterVolume = vol));
  }

  // ---------------------------------------------------------------- sections & steps

  selectSection(index: number): void {
    if (index < 0 || index >= SECTION_COUNT) return;
    this.sequencer.selectSection(index);
    if (this.sequencer.state === 'playing') {
      this.state.queuedSection = this.sequencer.queuedSection;
      this.emit();
    } else {
      // Viewing another section is not an edit, so it doesn't mark the pattern dirty.
      this.state.queuedSection = null;
      this.state.doc.activeSection = index;
      this.scheduleAutosave();
      this.emit();
    }
  }

  setSectionLength(length: number): void {
    const len = Math.round(clamp(length, MIN_LENGTH, MAX_LENGTH) / 2) * 2;
    this.change((d) => {
      const s = d.sections[d.activeSection];
      s.length = len;
      for (const t of TRACK_IDS) s.steps[t] = resizeSteps(s.steps[t], len);
    });
  }

  setStep(track: TrackId, step: number, value: StepValue, section = this.state.doc.activeSection): void {
    const s = this.state.doc.sections[section];
    if (!s || step < 0 || step >= s.length) return;
    this.change(() => (s.steps[track][step] = value));
  }

  /** Click: off ↔ on. With accent: toggles accent (off/on → accent, accent → on). */
  toggleStep(track: TrackId, step: number, accent = false): StepValue {
    const s = this.state.doc.sections[this.state.doc.activeSection];
    const cur = s.steps[track][step] ?? 0;
    const next: StepValue = accent ? (cur === 2 ? 1 : 2) : cur ? 0 : 1;
    this.setStep(track, step, next);
    return next;
  }

  clearSection(): void {
    this.change((d) => {
      const s = d.sections[d.activeSection];
      for (const t of TRACK_IDS) s.steps[t] = new Array<StepValue>(s.length).fill(0);
    });
  }

  copySectionTo(target: number): void {
    if (target < 0 || target >= SECTION_COUNT || target === this.state.doc.activeSection) return;
    this.change((d) => {
      d.sections[target] = structuredClone(d.sections[d.activeSection]);
    });
  }

  // ---------------------------------------------------------------- tracks

  selectTrack(track: TrackId): void {
    this.state.selectedTrack = track;
    this.scheduleAutosave();
    this.emit();
  }

  setTrackParam<K extends keyof TrackSound>(track: TrackId, key: K, value: TrackSound[K]): void {
    this.change(
      (d) => {
        const s = d.tracks[track];
        s[key] = value;
        if (key === 'start' && s.end - s.start < 0.005) s.start = Math.max(0, s.end - 0.005);
        if (key === 'end' && s.end - s.start < 0.005) s.end = Math.min(1, s.start + 0.005);
      },
      { mix: key === 'volume' || key === 'pan' || key === 'mute' || key === 'solo' || key === 'tone' },
    );
  }

  toggleMute(track: TrackId): void {
    this.setTrackParam(track, 'mute', !this.state.doc.tracks[track].mute);
  }

  toggleSolo(track: TrackId): void {
    this.setTrackParam(track, 'solo', !this.state.doc.tracks[track].solo);
  }

  /** Restore a track's sound to factory settings (mute/solo are left alone). */
  resetTrack(track: TrackId): void {
    this.change(
      (d) => {
        const { mute, solo } = d.tracks[track];
        d.tracks[track] = { ...defaultTrackSound(track), mute, solo };
      },
      { mix: true },
    );
  }

  async audition(track: TrackId = this.state.selectedTrack): Promise<void> {
    const state = await this.engine.resume();
    this.state.audioState = state;
    if (state !== 'running') {
      this.toast('Audio could not start. Click again to allow sound.', 'error');
      return;
    }
    this.engine.audition(track, this.state.doc.tracks[track]);
  }

  // ---------------------------------------------------------------- samples

  /** Every selectable sound: built-ins first, then the user's library. */
  sampleOptions(): { id: string; name: string; group: string }[] {
    return [
      ...BUILTIN_SOUNDS.map((s) => ({ id: s.id, name: s.name, group: 'Built-in' })),
      ...this.state.samples
        .filter((s) => !this.state.brokenSamples.has(s.id))
        .map((s) => ({ id: s.id, name: s.name, group: 'Your samples' })),
    ];
  }

  sampleName(id: string): string {
    return this.sampleOptions().find((o) => o.id === id)?.name ?? 'Unknown';
  }

  sampleDuration(id: string): number {
    const buf = this.engine.getBuffer(id);
    if (buf) return buf.duration;
    const pcm = renderBuiltin(id);
    if (pcm) return pcm.length / SYNTH_SAMPLE_RATE;
    return this.state.samples.find((s) => s.id === id)?.duration ?? 0;
  }

  /** Waveform peaks for a sample, computed once and cached. */
  peaks(id: string): Float32Array | null {
    const hit = this.peaksCache.get(id);
    if (hit) return hit;
    let peaks: Float32Array | null = null;
    const buf = this.engine.getBuffer(id);
    if (buf) peaks = computePeaks(buf, 400);
    else {
      const pcm = renderBuiltin(id);
      if (pcm) {
        peaks = computePeaks(
          { duration: pcm.length / SYNTH_SAMPLE_RATE, numberOfChannels: 1, length: pcm.length, sampleRate: SYNTH_SAMPLE_RATE, getChannelData: () => pcm },
          400,
        );
      }
    }
    if (peaks) this.peaksCache.set(id, peaks);
    return peaks;
  }

  /** Decode a dropped/picked file and hold it for preview. Nothing is stored yet. */
  async importSampleFile(track: TrackId, file: File): Promise<boolean> {
    this.engine.stopPreview();
    this.state.importing = true;
    this.state.pending = null;
    this.emit();
    const result = await loadSampleFile(file, (data) => this.engine.decode(data));
    this.state.importing = false;
    if (!result.ok) {
      this.toast(result.error, 'error');
      this.emit();
      return false;
    }
    this.state.pending = { track, sample: result.sample };
    this.state.selectedTrack = track;
    this.emit();
    return true;
  }

  async previewPending(): Promise<void> {
    const p = this.state.pending;
    if (!p) return;
    const state = await this.engine.resume();
    if (state !== 'running') {
      this.toast('Audio could not start. Click again to allow sound.', 'error');
      return;
    }
    this.engine.previewBuffer(p.sample.buffer);
  }

  cancelPending(): void {
    this.engine.stopPreview();
    this.state.pending = null;
    this.emit();
  }

  /** Store the pending sample locally (IndexedDB) and assign it to its track. */
  async assignPending(): Promise<boolean> {
    const p = this.state.pending;
    if (!p) return false;
    this.engine.stopPreview();
    const id = `user:${newId()}`;
    const rec = {
      id,
      name: p.sample.name,
      mimeType: p.sample.mimeType,
      size: p.sample.size,
      duration: p.sample.buffer.duration,
      createdAt: this.wallNow(),
      data: p.sample.data,
    };
    try {
      await this.storage.putSample(rec);
    } catch {
      this.toast('The sample could not be saved to browser storage (it may be full).', 'error');
      return false;
    }
    this.engine.setBuffer(id, p.sample.buffer);
    this.peaksCache.set(id, p.sample.peaks);
    const { data: _data, ...meta } = rec;
    this.state.samples = [...this.state.samples, meta].sort((a, b) => a.name.localeCompare(b.name));
    this.state.pending = null;
    this.change((d) => {
      const s = d.tracks[p.track];
      s.sampleId = id;
      s.start = 0;
      s.end = 1;
    });
    this.toast(`"${rec.name}" assigned to ${TRACK_LABELS[p.track]}.`, 'success');
    return true;
  }

  setTrackSample(track: TrackId, sampleId: string): void {
    if (!this.sampleOptions().some((o) => o.id === sampleId)) return;
    this.change((d) => {
      const s = d.tracks[track];
      s.sampleId = sampleId;
      s.start = 0;
      s.end = 1;
    });
  }

  /** Remove a custom sample from a track, reverting to the built-in default. */
  removeTrackSample(track: TrackId): void {
    this.setTrackSample(track, DEFAULT_SAMPLE[track]);
  }

  /** Delete an imported sample from the library; tracks using it revert to their defaults. */
  async deleteSample(id: string): Promise<void> {
    if (!id.startsWith('user:')) return;
    try {
      await this.storage.deleteSample(id);
    } catch {
      this.toast('Could not delete the sample from browser storage.', 'error');
      return;
    }
    this.engine.removeBuffer(id);
    this.peaksCache.delete(id);
    this.state.samples = this.state.samples.filter((s) => s.id !== id);
    const affected = TRACK_IDS.filter((t) => this.state.doc.tracks[t].sampleId === id);
    if (affected.length) {
      this.change((d) => {
        for (const t of affected) d.tracks[t] = { ...d.tracks[t], sampleId: DEFAULT_SAMPLE[t], start: 0, end: 1 };
      });
    } else this.emit();
  }

  // ---------------------------------------------------------------- pattern library

  async refreshPatternList(): Promise<void> {
    let raw: unknown[] = [];
    try {
      raw = await this.storage.listPatterns();
    } catch {
      this.toast('Could not read saved patterns.', 'error');
    }
    const entries: SavedPatternEntry[] = [];
    for (const r of raw) {
      const rec = r as Partial<SavedPatternRecord> | null;
      if (!rec || typeof rec.id !== 'string') continue;
      const valid = validatePatternDoc(rec.doc).ok;
      entries.push({
        id: rec.id,
        name: typeof rec.name === 'string' ? rec.name : '(unnamed)',
        updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : 0,
        corrupt: !valid,
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    this.state.savedPatterns = entries;
    this.emit();
  }

  private async writePattern(id: string, name: string, doc: PatternDoc, createdAt?: number): Promise<boolean> {
    const now = this.wallNow();
    const rec: SavedPatternRecord = { id, name, createdAt: createdAt ?? now, updatedAt: now, doc: { ...cloneDoc(doc), name } };
    try {
      await this.storage.putPattern(rec);
      return true;
    } catch {
      this.toast('Could not save the pattern to browser storage.', 'error');
      return false;
    }
  }

  /** Save over the current library entry, or create one if the pattern was never saved. */
  async save(): Promise<boolean> {
    const id = this.state.currentPatternId;
    if (!id || !this.state.savedPatterns.some((p) => p.id === id)) return this.saveAs(this.state.doc.name);
    const existing = (await this.storage.getPattern(id)) as SavedPatternRecord | undefined;
    if (!(await this.writePattern(id, this.state.doc.name, this.state.doc, existing?.createdAt))) return false;
    this.state.dirty = false;
    await this.refreshPatternList();
    await this.saveSession();
    this.toast(`Saved "${this.state.doc.name}".`, 'success');
    return true;
  }

  async saveAs(name: string): Promise<boolean> {
    const clean = name.trim().slice(0, 80) || 'Untitled';
    const id = newId();
    if (!(await this.writePattern(id, clean, this.state.doc))) return false;
    this.state.doc.name = clean;
    this.state.currentPatternId = id;
    this.state.dirty = false;
    await this.refreshPatternList();
    await this.saveSession();
    this.toast(`Saved "${clean}".`, 'success');
    return true;
  }

  async loadPattern(id: string, announce = true): Promise<boolean> {
    let raw: unknown;
    try {
      raw = await this.storage.getPattern(id);
    } catch {
      raw = undefined;
    }
    const rec = raw as Partial<SavedPatternRecord> | undefined;
    const result = validatePatternDoc(rec?.doc);
    if (!result.ok) {
      this.toast(`This saved pattern is corrupted and cannot be loaded (${result.error})`, 'error');
      return false;
    }
    if (this.sequencer.state !== 'stopped') this.stop();
    this.setDoc(result.value);
    this.state.currentPatternId = id;
    this.state.dirty = false;
    if (result.warnings.length) this.toast('Some values in this pattern were invalid and have been repaired.', 'warning');
    await this.saveSession();
    if (announce) this.toast(`Loaded "${result.value.name}".`, 'info');
    this.emit();
    return true;
  }

  async renamePattern(id: string, name: string): Promise<boolean> {
    const clean = name.trim().slice(0, 80);
    if (!clean) return false;
    const rec = (await this.storage.getPattern(id)) as SavedPatternRecord | undefined;
    if (!rec) return false;
    const valid = validatePatternDoc(rec.doc);
    const doc = valid.ok ? valid.value : blankPattern(clean);
    if (!(await this.writePattern(id, clean, doc, rec.createdAt))) return false;
    if (this.state.currentPatternId === id) {
      this.state.doc.name = clean;
      await this.saveSession();
    }
    await this.refreshPatternList();
    return true;
  }

  /** Rename the working pattern (and its library entry, if saved). */
  async renameCurrent(name: string): Promise<void> {
    const clean = name.trim().slice(0, 80);
    if (!clean || clean === this.state.doc.name) return;
    const id = this.state.currentPatternId;
    if (id && this.state.savedPatterns.some((p) => p.id === id)) {
      await this.renamePattern(id, clean);
    }
    this.change((d) => (d.name = clean));
  }

  async duplicatePattern(id: string): Promise<string | null> {
    const rec = (await this.storage.getPattern(id)) as SavedPatternRecord | undefined;
    const valid = validatePatternDoc(rec?.doc);
    if (!rec || !valid.ok) {
      this.toast('This pattern cannot be duplicated because its data is corrupted.', 'error');
      return null;
    }
    const names = new Set(this.state.savedPatterns.map((p) => p.name));
    let name = `${rec.name} copy`;
    for (let i = 2; names.has(name); i++) name = `${rec.name} copy ${i}`;
    const newIdValue = newId();
    if (!(await this.writePattern(newIdValue, name, valid.value))) return null;
    await this.refreshPatternList();
    return newIdValue;
  }

  async deletePattern(id: string): Promise<void> {
    try {
      await this.storage.deletePattern(id);
    } catch {
      this.toast('Could not delete the pattern.', 'error');
      return;
    }
    if (this.state.currentPatternId === id) {
      this.state.currentPatternId = null;
      this.state.dirty = true;
      await this.saveSession();
    }
    await this.refreshPatternList();
  }

  newBlankPattern(): void {
    if (this.sequencer.state !== 'stopped') this.stop();
    const doc = blankPattern('Untitled');
    doc.bpm = this.state.doc.bpm;
    this.setDoc(doc);
    this.state.currentPatternId = null;
    this.state.dirty = false;
    void this.saveSession();
    this.emit();
  }

  /** (Re-)add the example patterns to the library. Existing examples are overwritten. */
  async restoreExamples(announce = true): Promise<void> {
    for (const ex of examplePatterns()) {
      const id = EXAMPLE_PREFIX + ex.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await this.writePattern(id, ex.name, ex);
    }
    await this.refreshPatternList();
    if (announce) this.toast('Example patterns restored to the library.', 'success');
  }

  // ---------------------------------------------------------------- import / export

  /** Build the JSON export. Custom samples used by the pattern are embedded unless disabled. */
  async exportJson(embedSamples = true): Promise<string> {
    const samples: ExportFile['samples'] = [];
    if (embedSamples) {
      const ids = new Set(TRACK_IDS.map((t) => this.state.doc.tracks[t].sampleId).filter((id) => id.startsWith('user:')));
      for (const id of ids) {
        const rec = await this.storage.getSample(id);
        if (rec) samples.push({ id, name: rec.name, mimeType: rec.mimeType, data: arrayBufferToBase64(rec.data) });
      }
    }
    const file: ExportFile = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date(this.wallNow()).toISOString(),
      pattern: this.state.doc,
      samples,
    };
    return JSON.stringify(file, null, 1);
  }

  /** Import an exported pattern. The result becomes the (unsaved) working pattern. */
  async importJson(text: string): Promise<boolean> {
    const parsed = parseJson(text);
    if (!parsed.ok) {
      this.toast(`Import failed: ${parsed.error}`, 'error');
      return false;
    }
    const result = validateExportFile(parsed.value);
    if (!result.ok) {
      this.toast(`Import failed: ${result.error}`, 'error');
      return false;
    }
    const { pattern, samples } = result.value;
    let failed = 0;
    for (const s of samples) {
      if (this.state.samples.some((m) => m.id === s.id) && !this.state.brokenSamples.has(s.id)) continue;
      try {
        const data = base64ToArrayBuffer(s.data);
        if (data.byteLength === 0) throw new Error('empty');
        const buffer = await this.engine.decode(data);
        if (!validateDecoded(s.name, buffer).ok) throw new Error('invalid');
        const rec = { id: s.id, name: s.name, mimeType: s.mimeType, size: data.byteLength, duration: buffer.duration, createdAt: this.wallNow(), data };
        await this.storage.putSample(rec);
        this.engine.setBuffer(s.id, buffer);
        this.peaksCache.set(s.id, computePeaks(buffer, 400));
        this.state.brokenSamples.delete(s.id);
        const { data: _d, ...meta } = rec;
        this.state.samples = [...this.state.samples.filter((m) => m.id !== s.id), meta].sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        failed++;
      }
    }
    if (this.sequencer.state !== 'stopped') this.stop();
    this.setDoc(pattern);
    this.state.currentPatternId = null;
    this.state.dirty = true;
    await this.saveSession();
    if (failed) this.toast(`${failed} embedded sample(s) could not be decoded and were skipped.`, 'warning');
    if (result.warnings.length) this.toast(`Imported with ${result.warnings.length} repaired value(s).`, 'warning');
    else this.toast(`Imported "${pattern.name}". Save it to keep it in your library.`, 'success');
    this.emit();
    return true;
  }

  dispose(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.sequencer.dispose();
    void this.engine.dispose();
    this.listeners.clear();
    this.toastListeners.clear();
  }
}
