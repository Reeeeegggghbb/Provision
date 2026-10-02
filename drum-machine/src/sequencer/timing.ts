import { BEATS_PER_BAR, STEPS_PER_BEAT, SWING_MAX, SWING_MIN } from '../model/types';

/** Duration of one 16th-note step in seconds. */
export function stepDuration(bpm: number, stepsPerBeat = STEPS_PER_BEAT): number {
  if (!(bpm > 0)) throw new RangeError(`Invalid tempo: ${bpm}`);
  return 60 / bpm / stepsPerBeat;
}

/**
 * Delay applied to a step by swing. Swing is the position of the off-beat 16th inside its
 * 8th-note pair: 0.5 = straight, 0.667 ≈ triplet feel, 0.75 = dotted feel. Only odd steps
 * (the second 16th of each pair) are delayed, so the beat grid itself never moves and swing
 * cannot accumulate drift.
 */
export function swingOffset(stepInSection: number, stepDur: number, swing: number): number {
  if (stepInSection % 2 !== 1) return 0;
  const s = Math.min(SWING_MAX, Math.max(SWING_MIN, swing));
  return (s - 0.5) * 2 * stepDur;
}

/** Swing as a display percentage (50% = straight). */
export function swingPercent(swing: number): number {
  return Math.round(swing * 100);
}

/**
 * Unswung time of absolute grid step `n` relative to an anchor. Computing from an anchor
 * (rather than repeatedly adding the step duration) avoids floating-point drift.
 */
export function gridTime(anchorTime: number, anchorStep: number, n: number, stepDur: number): number {
  return anchorTime + (n - anchorStep) * stepDur;
}

export interface StepPosition {
  /** 1-based bar number */
  bar: number;
  /** 1-based beat within the bar */
  beat: number;
  /** 1-based 16th subdivision within the beat */
  sub: number;
}

export function stepPosition(step: number): StepPosition {
  return {
    bar: Math.floor(step / (STEPS_PER_BEAT * BEATS_PER_BAR)) + 1,
    beat: (Math.floor(step / STEPS_PER_BEAT) % BEATS_PER_BAR) + 1,
    sub: (step % STEPS_PER_BEAT) + 1,
  };
}

export function isBeatStart(step: number): boolean {
  return step % STEPS_PER_BEAT === 0;
}

export function isBarStart(step: number): boolean {
  return step % (STEPS_PER_BEAT * BEATS_PER_BAR) === 0;
}

/** Playback-rate multiplier for a tuning in semitones + cents. */
export function tuningRatio(semitones: number, cents: number): number {
  return Math.pow(2, (semitones + cents / 100) / 12);
}
