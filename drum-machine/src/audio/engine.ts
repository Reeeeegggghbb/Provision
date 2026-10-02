import { DEFAULT_SAMPLE } from '../model/defaults';
import { TRACK_IDS, type TrackId, type TrackSound } from '../model/types';
import { tuningRatio } from '../sequencer/timing';
import { BUILTIN_SOUNDS, renderBuiltin, SYNTH_SAMPLE_RATE } from './synth';

export type ContextFactory = () => AudioContext;

interface Channel {
  filter: BiquadFilterNode;
  panner: StereoPannerNode | null;
  gain: GainNode;
}

export interface Voice {
  track: TrackId | null;
  source: AudioBufferSourceNode;
  env: GainNode;
  extra: AudioNode[];
  startTime: number;
  endTime: number;
  chokeGroup: number;
  done: boolean;
}

export class SampleDecodeError extends Error {}

/** Map the -1..1 tone control to a filter setting. */
export function toneToFilter(tone: number): { type: BiquadFilterType; frequency: number } {
  if (tone < -0.001) return { type: 'lowpass', frequency: 20000 * Math.pow(200 / 20000, -tone) };
  if (tone > 0.001) return { type: 'highpass', frequency: 20 * Math.pow(4000 / 20, tone) };
  return { type: 'lowpass', frequency: 20000 };
}

/** Effective channel gain once mute and solo are taken into account. */
export function effectiveGain(sound: TrackSound, anySolo: boolean): number {
  if (sound.mute) return 0;
  if (anySolo && !sound.solo) return 0;
  return sound.volume;
}

/** Velocity multiplier for a step value (1 = normal, 2 = accent). */
export function velocityFor(step: number): number {
  return step >= 2 ? 1 : 0.72;
}

/**
 * Web Audio engine. Long-lived nodes (one channel strip per track and a master bus) are
 * created once; each hit creates only an AudioBufferSourceNode and an envelope GainNode,
 * which are disconnected as soon as they finish or are cancelled.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private channels = new Map<TrackId, Channel>();
  private buffers = new Map<string, AudioBuffer>();
  private voices = new Set<Voice>();
  private previewVoice: Voice | null = null;
  private masterVolume = 0.8;
  onStateChange: ((state: string) => void) | null = null;

  constructor(private createContext: ContextFactory) {}

  get context(): AudioContext | null {
    return this.ctx;
  }

  get state(): string {
    return this.ctx?.state ?? 'uninitialised';
  }

  get currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Output latency (seconds) to compensate visual sync, where the browser reports it. */
  get outputLatency(): number {
    const c = this.ctx as (AudioContext & { outputLatency?: number }) | null;
    if (!c) return 0;
    const lat = typeof c.outputLatency === 'number' && c.outputLatency > 0 ? c.outputLatency : (c.baseLatency ?? 0);
    return Number.isFinite(lat) ? Math.min(lat, 0.5) : 0;
  }

  get activeVoiceCount(): number {
    return this.voices.size;
  }

  /** Create the AudioContext and the static graph if needed. Safe to call repeatedly. */
  ensureContext(): AudioContext {
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
    this.teardownGraph();
    const ctx = this.createContext();
    this.ctx = ctx;
    ctx.onstatechange = () => this.onStateChange?.(ctx.state);

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;
    this.master.connect(this.limiter);

    for (const track of TRACK_IDS) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 20000;
      filter.Q.value = 0.707;
      const panner = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
      const gain = ctx.createGain();
      if (panner) {
        filter.connect(panner);
        panner.connect(gain);
      } else {
        filter.connect(gain);
      }
      gain.connect(this.master);
      this.channels.set(track, { filter, panner, gain });
    }

    // Re-create buffers for the new context: built-ins are re-rendered from cached PCM.
    const old = this.buffers;
    this.buffers = new Map();
    for (const s of BUILTIN_SOUNDS) {
      const pcm = renderBuiltin(s.id, SYNTH_SAMPLE_RATE)!;
      const buf = ctx.createBuffer(1, pcm.length, SYNTH_SAMPLE_RATE);
      buf.copyToChannel(pcm, 0);
      this.buffers.set(s.id, buf);
    }
    for (const [id, buf] of old) if (!id.startsWith('builtin:')) this.buffers.set(id, buf);
    return ctx;
  }

  /**
   * Resume the context. Must be called from a user-gesture handler (click/keydown) the first
   * time, because browsers start AudioContexts suspended until the user interacts.
   */
  async resume(): Promise<string> {
    const ctx = this.ensureContext();
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        // Reported via the returned state.
      }
    }
    return ctx.state;
  }

  setBuffer(id: string, buffer: AudioBuffer): void {
    this.buffers.set(id, buffer);
  }

  removeBuffer(id: string): void {
    this.buffers.delete(id);
  }

  getBuffer(id: string): AudioBuffer | undefined {
    return this.buffers.get(id);
  }

  /** Resolve the buffer for a track, falling back to the track's built-in default. */
  resolveBuffer(track: TrackId | null, sampleId: string): AudioBuffer | undefined {
    return this.buffers.get(sampleId) ?? (track ? this.buffers.get(DEFAULT_SAMPLE[track]) : undefined);
  }

  /** Decode encoded audio bytes. The input is copied, so the caller's buffer stays usable. */
  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ensureContext();
    const copy = data.slice(0);
    try {
      return await new Promise<AudioBuffer>((resolve, reject) => {
        const p = ctx.decodeAudioData(copy, resolve, (e) => reject(e ?? new Error('decode failed')));
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
    } catch (e) {
      throw new SampleDecodeError(e instanceof Error && e.message ? e.message : 'The browser could not decode this audio data.');
    }
  }

  setMasterVolume(v: number): void {
    this.masterVolume = v;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  }

  /** Push volume, pan, mute/solo and tone settings to the channel strips. */
  applyMix(tracks: Record<TrackId, TrackSound>): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const anySolo = TRACK_IDS.some((t) => tracks[t].solo);
    for (const t of TRACK_IDS) {
      const ch = this.channels.get(t);
      if (!ch) continue;
      const s = tracks[t];
      ch.gain.gain.setTargetAtTime(effectiveGain(s, anySolo), now, 0.01);
      ch.panner?.pan.setTargetAtTime(s.pan, now, 0.01);
      const f = toneToFilter(s.tone);
      if (ch.filter.type !== f.type) ch.filter.type = f.type;
      ch.filter.frequency.setTargetAtTime(f.frequency, now, 0.01);
    }
  }

  /** Schedule one drum hit at AudioContext time `time`. Returns null if nothing could play. */
  trigger(track: TrackId, sound: TrackSound, time: number, velocity = 1): Voice | null {
    if (!this.ctx) return null;
    const ch = this.channels.get(track);
    if (!ch) return null;
    const voice = this.createVoice(track, sound, time, velocity, ch.filter);
    if (voice && sound.chokeGroup > 0) this.choke(voice, time);
    return voice;
  }

  /**
   * Play a track's sound immediately with all its sound settings, bypassing mute/solo so a
   * muted track can still be auditioned.
   */
  audition(track: TrackId, sound: TrackSound): Voice | null {
    if (!this.ctx || !this.master) return null;
    const ctx = this.ctx;
    const f = toneToFilter(sound.tone);
    const filter = ctx.createBiquadFilter();
    filter.type = f.type;
    filter.frequency.value = f.frequency;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(sound.volume, 0.05);
    const panner = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = sound.pan;
      filter.connect(panner);
      panner.connect(gain);
    } else filter.connect(gain);
    gain.connect(this.master);
    const extra: AudioNode[] = panner ? [filter, panner, gain] : [filter, gain];
    const voice = this.createVoice(track, sound, ctx.currentTime + 0.005, 1, filter, extra);
    if (!voice) extra.forEach((n) => n.disconnect());
    return voice;
  }

  /** Play a raw buffer (e.g. a sample being previewed before import). Stops any previous preview. */
  previewBuffer(buffer: AudioBuffer): Voice | null {
    if (!this.ctx || !this.master) return null;
    if (this.previewVoice && !this.previewVoice.done) this.killVoice(this.previewVoice);
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const env = ctx.createGain();
    env.gain.value = 0.9;
    source.connect(env);
    env.connect(this.master);
    const t = ctx.currentTime + 0.005;
    const voice: Voice = {
      track: null,
      source,
      env,
      extra: [],
      startTime: t,
      endTime: t + buffer.duration,
      chokeGroup: 0,
      done: false,
    };
    source.onended = () => this.cleanupVoice(voice);
    this.voices.add(voice);
    source.start(t);
    this.previewVoice = voice;
    return voice;
  }

  stopPreview(): void {
    if (this.previewVoice && !this.previewVoice.done) this.killVoice(this.previewVoice);
    this.previewVoice = null;
  }

  private createVoice(
    track: TrackId,
    sound: TrackSound,
    time: number,
    velocity: number,
    destination: AudioNode,
    extra: AudioNode[] = [],
  ): Voice | null {
    const ctx = this.ctx!;
    const buffer = this.resolveBuffer(track, sound.sampleId);
    if (!buffer || buffer.duration <= 0) return null;

    const start = Math.min(Math.max(sound.start, 0), 0.999);
    const end = Math.max(Math.min(sound.end, 1), start + 0.001);
    const offset = start * buffer.duration;
    const regionLen = (end - start) * buffer.duration;
    const rate = tuningRatio(sound.semitones, sound.cents);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (sound.pitchEnvAmount !== 0) {
      // Pitch envelope: start detuned by `pitchEnvAmount` semitones and glide back to the
      // tuned pitch. Implemented via playbackRate, so it also changes playback speed.
      const startRate = rate * Math.pow(2, sound.pitchEnvAmount / 12);
      source.playbackRate.setValueAtTime(startRate, time);
      source.playbackRate.exponentialRampToValueAtTime(rate, time + sound.pitchEnvTime);
    } else {
      source.playbackRate.setValueAtTime(rate, time);
    }

    const env = ctx.createGain();
    const peak = Math.max(0, velocity);
    const attack = Math.max(sound.attack, 0.001);
    const hold = sound.decay * 0.3;
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + attack);
    env.gain.setValueAtTime(peak, time + attack + hold);
    env.gain.setTargetAtTime(0, time + attack + hold, (sound.decay * 0.7) / 5);

    source.connect(env);
    env.connect(destination);

    const envEnd = time + attack + sound.decay;
    const naturalEnd = time + regionLen / rate;
    const endTime = Math.min(envEnd, naturalEnd + (sound.pitchEnvAmount < 0 ? sound.pitchEnvTime : 0));
    // `duration` in start() is measured in buffer time, so the region is respected at any rate.
    source.start(time, offset, regionLen);
    source.stop(envEnd + 0.01);

    const voice: Voice = {
      track,
      source,
      env,
      extra,
      startTime: time,
      endTime,
      chokeGroup: sound.chokeGroup,
      done: false,
    };
    source.onended = () => this.cleanupVoice(voice);
    this.voices.add(voice);
    return voice;
  }

  /** Fade out other voices in the same choke group (e.g. closed hat cuts open hat). */
  private choke(voice: Voice, time: number): void {
    for (const v of this.voices) {
      if (v === voice || v.done || v.chokeGroup !== voice.chokeGroup) continue;
      if (v.startTime >= time || v.endTime <= time) continue;
      this.fadeVoice(v, time, 0.012);
    }
  }

  private fadeVoice(v: Voice, time: number, fade: number): void {
    const g = v.env.gain as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
    if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(time);
    else g.cancelScheduledValues(time);
    g.setTargetAtTime(0, time, fade / 4);
    try {
      v.source.stop(time + fade);
    } catch {
      // Older engines throw if stop() was already called; the gain fade still silences it.
    }
    v.endTime = Math.min(v.endTime, time + fade);
  }

  /**
   * Cancel voices scheduled to start after `fromTime` (they are stopped before making any
   * sound). With `release`, voices already sounding are faded out quickly as well.
   */
  cancelFrom(fromTime: number, release = false): number {
    let cancelled = 0;
    for (const v of [...this.voices]) {
      if (v === this.previewVoice) continue;
      if (v.startTime > fromTime) {
        this.killVoice(v);
        cancelled++;
      } else if (release) {
        this.fadeVoice(v, Math.max(fromTime, this.currentTime), 0.03);
      }
    }
    return cancelled;
  }

  private killVoice(v: Voice): void {
    try {
      v.source.stop();
    } catch {
      // Ignore: already stopped.
    }
    this.cleanupVoice(v);
  }

  private cleanupVoice(v: Voice): void {
    if (v.done) return;
    v.done = true;
    v.source.onended = null;
    v.source.disconnect();
    v.env.disconnect();
    for (const n of v.extra) n.disconnect();
    this.voices.delete(v);
    if (this.previewVoice === v) this.previewVoice = null;
  }

  private teardownGraph(): void {
    for (const v of [...this.voices]) this.killVoice(v);
    for (const ch of this.channels.values()) {
      ch.filter.disconnect();
      ch.panner?.disconnect();
      ch.gain.disconnect();
    }
    this.channels.clear();
    this.master?.disconnect();
    this.limiter?.disconnect();
    this.master = null;
    this.limiter = null;
  }

  /** Release every node and close the context. */
  async dispose(): Promise<void> {
    this.teardownGraph();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      ctx.onstatechange = null;
      if (ctx.state !== 'closed') await ctx.close().catch(() => undefined);
    }
  }
}
