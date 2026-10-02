import {
  SECTION_COUNT,
  TRACK_IDS,
  type PatternDoc,
  type Section,
  type StepValue,
  type TrackId,
  type TrackSound,
} from './types';

export const DEFAULT_SAMPLE: Record<TrackId, string> = {
  kick: 'builtin:kick-deep',
  snare: 'builtin:snare-classic',
  closedHat: 'builtin:hat-closed',
  openHat: 'builtin:hat-open',
  clap: 'builtin:clap',
  rim: 'builtin:rimshot',
  tom: 'builtin:tom-low',
};

const DEFAULT_DECAY: Record<TrackId, number> = {
  kick: 1.2,
  snare: 0.8,
  closedHat: 0.4,
  openHat: 1.4,
  clap: 0.8,
  rim: 0.4,
  tom: 1.2,
};

const DEFAULT_VOLUME: Record<TrackId, number> = {
  kick: 0.9,
  snare: 0.8,
  closedHat: 0.6,
  openHat: 0.55,
  clap: 0.7,
  rim: 0.65,
  tom: 0.75,
};

const DEFAULT_PAN: Record<TrackId, number> = {
  kick: 0,
  snare: 0,
  closedHat: 0.15,
  openHat: 0.2,
  clap: -0.1,
  rim: -0.2,
  tom: -0.15,
};

export function defaultTrackSound(track: TrackId): TrackSound {
  return {
    sampleId: DEFAULT_SAMPLE[track],
    volume: DEFAULT_VOLUME[track],
    pan: DEFAULT_PAN[track],
    mute: false,
    solo: false,
    semitones: 0,
    cents: 0,
    attack: 0,
    decay: DEFAULT_DECAY[track],
    start: 0,
    end: 1,
    pitchEnvAmount: 0,
    pitchEnvTime: 0.05,
    tone: 0,
    chokeGroup: track === 'closedHat' || track === 'openHat' ? 1 : 0,
  };
}

export function defaultTracks(): Record<TrackId, TrackSound> {
  return Object.fromEntries(TRACK_IDS.map((t) => [t, defaultTrackSound(t)])) as Record<TrackId, TrackSound>;
}

export function emptySection(length = 16): Section {
  return {
    length,
    steps: Object.fromEntries(TRACK_IDS.map((t) => [t, new Array<StepValue>(length).fill(0)])) as Record<
      TrackId,
      StepValue[]
    >,
  };
}

export function blankPattern(name = 'Untitled'): PatternDoc {
  return {
    version: 1,
    name,
    bpm: 120,
    swing: 0.5,
    masterVolume: 0.8,
    activeSection: 0,
    sections: Array.from({ length: SECTION_COUNT }, () => emptySection(16)),
    tracks: defaultTracks(),
  };
}

/** Resize a step row, keeping existing steps and padding with zeros. */
export function resizeSteps(steps: StepValue[], length: number): StepValue[] {
  const out = steps.slice(0, length);
  while (out.length < length) out.push(0);
  return out;
}

export function cloneDoc(doc: PatternDoc): PatternDoc {
  return structuredClone(doc);
}
