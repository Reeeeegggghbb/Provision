import { describe, expect, it } from 'vitest';
import {
  gridTime,
  isBarStart,
  isBeatStart,
  stepDuration,
  stepPosition,
  swingOffset,
  swingPercent,
  tuningRatio,
} from '../../src/sequencer/timing';

describe('step-to-time calculations', () => {
  it.each([
    [40, 0.375],
    [60, 0.25],
    [90, 1 / 6],
    [120, 0.125],
    [174, 60 / 174 / 4],
    [240, 0.0625],
  ])('16th note at %d BPM lasts %f s', (bpm, expected) => {
    expect(stepDuration(bpm)).toBeCloseTo(expected, 12);
  });

  it('rejects non-positive tempos', () => {
    expect(() => stepDuration(0)).toThrow(RangeError);
    expect(() => stepDuration(NaN)).toThrow(RangeError);
  });

  it('computes grid times from an anchor without accumulating error', () => {
    const dur = stepDuration(133);
    let accumulated = 10;
    for (let i = 0; i < 100_000; i++) accumulated += dur;
    const anchored = gridTime(10, 0, 100_000, dur);
    expect(anchored).toBeCloseTo(10 + 100_000 * dur, 9);
    // Repeated addition drifts; the anchored form is exact to float precision.
    expect(Math.abs(anchored - (10 + (100_000 * 60) / 133 / 4))).toBeLessThan(1e-9);
    expect(Math.abs(accumulated - anchored)).toBeGreaterThanOrEqual(0);
  });

  it('a 4/4 bar of 16 steps lasts 4 beats at any tempo', () => {
    for (const bpm of [40, 97, 120, 240]) {
      expect(gridTime(0, 0, 16, stepDuration(bpm))).toBeCloseTo((60 / bpm) * 4, 12);
    }
  });
});

describe('beat and bar boundaries', () => {
  it('maps steps to bar/beat/subdivision', () => {
    expect(stepPosition(0)).toEqual({ bar: 1, beat: 1, sub: 1 });
    expect(stepPosition(3)).toEqual({ bar: 1, beat: 1, sub: 4 });
    expect(stepPosition(4)).toEqual({ bar: 1, beat: 2, sub: 1 });
    expect(stepPosition(15)).toEqual({ bar: 1, beat: 4, sub: 4 });
    expect(stepPosition(16)).toEqual({ bar: 2, beat: 1, sub: 1 });
    expect(stepPosition(31)).toEqual({ bar: 2, beat: 4, sub: 4 });
  });

  it('identifies beat and bar starts', () => {
    expect([0, 4, 8, 12, 16].every(isBeatStart)).toBe(true);
    expect([1, 2, 3, 5].some(isBeatStart)).toBe(false);
    expect(isBarStart(0)).toBe(true);
    expect(isBarStart(16)).toBe(true);
    expect(isBarStart(32)).toBe(true);
    expect(isBarStart(4)).toBe(false);
    expect(isBarStart(12)).toBe(false);
  });
});

describe('swing', () => {
  const dur = stepDuration(120);

  it('is a no-op at 50%', () => {
    for (let s = 0; s < 16; s++) expect(swingOffset(s, dur, 0.5)).toBe(0);
  });

  it('only delays odd (off-beat) 16ths', () => {
    for (let s = 0; s < 16; s += 2) expect(swingOffset(s, dur, 0.66)).toBe(0);
    for (let s = 1; s < 16; s += 2) expect(swingOffset(s, dur, 0.66)).toBeCloseTo(0.32 * dur, 12);
  });

  it('places the off-beat at the swing fraction of the 8th-note pair', () => {
    const pair = dur * 2;
    for (const sw of [0.5, 0.54, 0.6, 2 / 3, 0.75]) {
      const offbeatTime = dur + swingOffset(1, dur, sw);
      expect(offbeatTime / pair).toBeCloseTo(sw, 12);
    }
  });

  it('clamps out-of-range values', () => {
    expect(swingOffset(1, dur, 0.9)).toBeCloseTo(0.5 * dur, 12);
    expect(swingOffset(1, dur, 0.2)).toBe(0);
  });

  it('formats as a percentage', () => {
    expect(swingPercent(0.5)).toBe(50);
    expect(swingPercent(0.666)).toBe(67);
  });
});

describe('tuning', () => {
  it('converts semitones and cents to a playback ratio', () => {
    expect(tuningRatio(0, 0)).toBe(1);
    expect(tuningRatio(12, 0)).toBeCloseTo(2, 12);
    expect(tuningRatio(-12, 0)).toBeCloseTo(0.5, 12);
    expect(tuningRatio(7, 0)).toBeCloseTo(1.4983, 4);
    expect(tuningRatio(0, 100)).toBeCloseTo(tuningRatio(1, 0), 12);
    expect(tuningRatio(-1, 50)).toBeCloseTo(tuningRatio(0, -50), 12);
  });
});
