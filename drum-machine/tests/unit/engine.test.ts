import { beforeEach, describe, expect, it } from 'vitest';
import { AudioEngine, effectiveGain, SampleDecodeError, toneToFilter, velocityFor } from '../../src/audio/engine';
import { BUILTIN_SOUNDS } from '../../src/audio/synth';
import { defaultTrackSound, defaultTracks } from '../../src/model/defaults';
import { FakeAudioContext, FakeBuffer, FakeFilter, FakeGain, fakeAudioBytes, FakeSource } from './fakes';

let ctx: FakeAudioContext;
let engine: AudioEngine;
let created: number;

beforeEach(() => {
  created = 0;
  engine = new AudioEngine(() => {
    created++;
    ctx = new FakeAudioContext();
    return ctx.asReal();
  });
});

function lastSource(): FakeSource {
  const s = ctx.sources();
  return s[s.length - 1];
}

describe('context lifecycle', () => {
  it('creates the context lazily and only once', () => {
    expect(engine.state).toBe('uninitialised');
    engine.ensureContext();
    engine.ensureContext();
    expect(created).toBe(1);
  });

  it('resumes a suspended context (user gesture path)', async () => {
    engine.ensureContext();
    expect(ctx.state).toBe('suspended');
    expect(await engine.resume()).toBe('running');
    expect(ctx.resumeCalls).toBe(1);
    await engine.resume();
    expect(ctx.resumeCalls).toBe(1); // already running: no redundant resume
  });

  it('reports a failed resume instead of throwing', async () => {
    engine = new AudioEngine(() => (ctx = new FakeAudioContext({ resumeFails: true })).asReal());
    expect(await engine.resume()).toBe('suspended');
  });

  it('notifies state changes (suspension / interruption)', async () => {
    const states: string[] = [];
    engine.onStateChange = (s) => states.push(s);
    await engine.resume();
    ctx.setState('interrupted');
    ctx.setState('running');
    expect(states).toEqual(['running', 'interrupted', 'running']);
  });

  it('recreates a closed context and keeps user buffers', async () => {
    engine.ensureContext();
    const user = new FakeBuffer(1, 4800, 48000);
    engine.setBuffer('user:abc', user as unknown as AudioBuffer);
    const first = ctx;
    await first.close();
    engine.ensureContext();
    expect(created).toBe(2);
    expect(ctx).not.toBe(first);
    expect(engine.getBuffer('user:abc')).toBe(user);
    expect(engine.getBuffer('builtin:kick-deep')).toBeDefined();
  });

  it('renders every built-in sound into a buffer', () => {
    engine.ensureContext();
    for (const s of BUILTIN_SOUNDS) {
      const b = engine.getBuffer(s.id)!;
      expect(b.duration).toBeGreaterThan(0.1);
      const data = b.getChannelData(0);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeGreaterThan(0.5);
      expect(peak).toBeLessThanOrEqual(0.9001);
    }
  });

  it('dispose releases all nodes and closes the context', async () => {
    await engine.resume();
    engine.trigger('kick', defaultTrackSound('kick'), 0.5);
    await engine.dispose();
    expect(ctx.closed).toBe(true);
    expect(engine.activeVoiceCount).toBe(0);
    for (const n of ctx.nodes) if (n !== ctx.destination) expect(n.connected).toBe(false);
  });
});

describe('voice scheduling', () => {
  beforeEach(() => engine.ensureContext());

  it('starts the sample exactly at the requested AudioContext time', () => {
    engine.trigger('kick', defaultTrackSound('kick'), 1.234);
    const src = lastSource();
    expect(src.started!.when).toBe(1.234);
    expect(src.started!.offset).toBe(0);
    expect(src.started!.duration).toBeCloseTo(src.buffer!.duration, 9);
  });

  it('respects sample start/end points', () => {
    const sound = { ...defaultTrackSound('snare'), start: 0.25, end: 0.75 };
    engine.trigger('snare', sound, 2);
    const src = lastSource();
    const dur = src.buffer!.duration;
    expect(src.started!.offset).toBeCloseTo(0.25 * dur, 9);
    expect(src.started!.duration).toBeCloseTo(0.5 * dur, 9);
  });

  it('applies semitone and fine tuning as playback rate', () => {
    engine.trigger('tom', { ...defaultTrackSound('tom'), semitones: 12, cents: 0 }, 1);
    expect(lastSource().playbackRate.events).toEqual([['set', 2, 1]]);
    engine.trigger('tom', { ...defaultTrackSound('tom'), semitones: -5, cents: 30 }, 1);
    expect(lastSource().playbackRate.events[0][1]).toBeCloseTo(Math.pow(2, -4.7 / 12), 9);
  });

  it('applies a pitch envelope that glides back to the tuned pitch', () => {
    const sound = { ...defaultTrackSound('kick'), semitones: -2, pitchEnvAmount: 12, pitchEnvTime: 0.08 };
    engine.trigger('kick', sound, 3);
    const ev = lastSource().playbackRate.events;
    const base = Math.pow(2, -2 / 12);
    expect(ev[0][0]).toBe('set');
    expect(ev[0][1]).toBeCloseTo(base * 2, 9);
    expect(ev[1]).toEqual(['exp', base, 3.08]);
  });

  it('shapes amplitude with attack, velocity and decay, and stops at the end of the envelope', () => {
    const sound = { ...defaultTrackSound('clap'), attack: 0.02, decay: 0.5 };
    engine.trigger('clap', sound, 1, velocityFor(2));
    const src = lastSource();
    const env = [...src.connections][0] as FakeGain;
    expect(env.gain.events[0]).toEqual(['set', 0, 1]);
    expect(env.gain.events[1]).toEqual(['linear', 1, 1.02]);
    expect(env.gain.events.at(-1)![0]).toBe('target');
    expect(src.stops.at(-1)).toBeCloseTo(1 + 0.02 + 0.5 + 0.01, 9);
    engine.trigger('clap', sound, 2, velocityFor(1));
    const env2 = [...lastSource().connections][0] as FakeGain;
    expect(env2.gain.events[1][1]).toBeLessThan(1);
  });

  it('routes voices through the track channel strip', () => {
    engine.trigger('rim', defaultTrackSound('rim'), 1);
    const env = [...lastSource().connections][0] as FakeGain;
    expect([...env.connections][0]).toBeInstanceOf(FakeFilter);
  });

  it('falls back to the track default when the sample is missing', () => {
    engine.trigger('kick', { ...defaultTrackSound('kick'), sampleId: 'user:gone' }, 1);
    expect(lastSource().buffer).toBe(engine.getBuffer('builtin:kick-deep'));
  });

  it('creates only two nodes per hit and frees them when the voice ends', () => {
    const before = ctx.nodes.length;
    for (let i = 0; i < 10; i++) engine.trigger('closedHat', { ...defaultTrackSound('closedHat'), chokeGroup: 0 }, i * 0.1);
    expect(ctx.nodes.length - before).toBe(20);
    expect(engine.activeVoiceCount).toBe(10);
    for (const s of ctx.sources()) s.end();
    expect(engine.activeVoiceCount).toBe(0);
    for (const n of ctx.nodes.slice(before)) expect(n.connected).toBe(false);
  });

  it('chokes open hat when the closed hat plays', () => {
    const t = defaultTracks();
    engine.trigger('openHat', t.openHat, 1);
    const open = lastSource();
    engine.trigger('closedHat', t.closedHat, 1.25);
    const env = [...open.connections][0] as FakeGain;
    expect(env.gain.events.some(([m, , time]) => m === 'cancelHold' && time === 1.25)).toBe(true);
    expect(open.stops.at(-1)).toBeCloseTo(1.25 + 0.012, 9);
  });

  it('does not choke voices outside the group or not yet sounding', () => {
    const t = defaultTracks();
    engine.trigger('openHat', t.openHat, 2);
    const open = lastSource();
    engine.trigger('closedHat', t.closedHat, 1.5); // before the open hat starts
    engine.trigger('kick', t.kick, 2.5);
    expect(open.stops).toHaveLength(1);
  });
});

describe('cancellation', () => {
  beforeEach(() => engine.ensureContext());

  it('cancels pending voices and leaves sounding ones (pause)', () => {
    ctx.currentTime = 1;
    engine.trigger('kick', defaultTrackSound('kick'), 0.9); // sounding
    const sounding = lastSource();
    engine.trigger('kick', defaultTrackSound('kick'), 1.05); // pending
    const pending = lastSource();
    engine.trigger('snare', defaultTrackSound('snare'), 1.1); // pending
    expect(engine.cancelFrom(1)).toBe(2);
    expect(pending.stops.at(-1)).toBeUndefined(); // stop() with no time = immediately
    expect(pending.connected).toBe(false);
    expect(sounding.connected).toBe(true);
    expect(engine.activeVoiceCount).toBe(1);
  });

  it('fades sounding voices on stop (release)', () => {
    ctx.currentTime = 1;
    engine.trigger('openHat', defaultTrackSound('openHat'), 0.95);
    const src = lastSource();
    engine.cancelFrom(1, true);
    expect(src.stops.at(-1)).toBeCloseTo(1.03, 9);
  });

  it('a cancelled voice firing onended later does not double-clean', () => {
    ctx.currentTime = 0;
    engine.trigger('kick', defaultTrackSound('kick'), 1);
    const src = lastSource();
    const onended = src.onended;
    engine.cancelFrom(0);
    expect(() => onended?.()).not.toThrow();
    expect(engine.activeVoiceCount).toBe(0);
  });
});

describe('mix', () => {
  it('computes effective gain with mute and solo', () => {
    const s = defaultTrackSound('kick');
    expect(effectiveGain(s, false)).toBe(s.volume);
    expect(effectiveGain({ ...s, mute: true }, false)).toBe(0);
    expect(effectiveGain(s, true)).toBe(0);
    expect(effectiveGain({ ...s, solo: true }, true)).toBe(s.volume);
    expect(effectiveGain({ ...s, solo: true, mute: true }, true)).toBe(0);
  });

  it('maps tone to filters', () => {
    expect(toneToFilter(0)).toEqual({ type: 'lowpass', frequency: 20000 });
    expect(toneToFilter(-1).type).toBe('lowpass');
    expect(toneToFilter(-1).frequency).toBeCloseTo(200, 6);
    expect(toneToFilter(1).type).toBe('highpass');
    expect(toneToFilter(1).frequency).toBeCloseTo(4000, 6);
    expect(toneToFilter(-0.5).frequency).toBeCloseTo(2000, 6);
  });

  it('pushes channel gains, pan and tone', async () => {
    await engine.resume();
    const tracks = defaultTracks();
    tracks.snare.solo = true;
    tracks.clap.tone = 1;
    engine.applyMix(tracks);
    const gains = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain);
    // master + 7 channel gains; channel gains are the last 7 created after master
    const channelGains = gains.slice(1, 8);
    const values = channelGains.map((g) => g.gain.value);
    expect(values.filter((v) => v > 0)).toHaveLength(1);
    const filters = ctx.nodes.filter((n): n is FakeFilter => n instanceof FakeFilter);
    expect(filters[4].type).toBe('highpass');
  });

  it('audition bypasses mute and cleans up its temporary nodes', async () => {
    await engine.resume();
    const sound = { ...defaultTrackSound('kick'), mute: true };
    const voice = engine.audition('kick', sound)!;
    expect(voice).not.toBeNull();
    expect(voice.extra.length).toBeGreaterThan(0);
    (voice.source as unknown as FakeSource).end();
    for (const n of voice.extra) expect((n as unknown as FakeGain).connected).toBe(false);
  });

  it('preview replaces a previous preview', async () => {
    await engine.resume();
    const buf = new FakeBuffer(1, 48000, 48000) as unknown as AudioBuffer;
    const a = engine.previewBuffer(buf)!;
    engine.previewBuffer(buf);
    expect(a.done).toBe(true);
    engine.stopPreview();
    expect(engine.activeVoiceCount).toBe(0);
  });
});

describe('decoding', () => {
  it('decodes valid audio and leaves the input buffer intact', async () => {
    const bytes = fakeAudioBytes(0.5);
    const buf = await engine.decode(bytes);
    expect(buf.duration).toBeCloseTo(0.5, 6);
    expect(bytes.byteLength).toBe(16);
  });

  it('wraps decoder errors', async () => {
    await expect(engine.decode(new TextEncoder().encode('not audio at all').buffer)).rejects.toBeInstanceOf(SampleDecodeError);
    await expect(engine.decode(new ArrayBuffer(0))).rejects.toBeInstanceOf(SampleDecodeError);
  });
});
