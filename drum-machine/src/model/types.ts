export const TRACK_IDS = ['kick', 'snare', 'closedHat', 'openHat', 'clap', 'rim', 'tom'] as const;
export type TrackId = (typeof TRACK_IDS)[number];

export const TRACK_LABELS: Record<TrackId, string> = {
  kick: 'Kick',
  snare: 'Snare',
  closedHat: 'Closed Hat',
  openHat: 'Open Hat',
  clap: 'Clap',
  rim: 'Rimshot',
  tom: 'Tom',
};

/** Number of independent sections (A–D) in a pattern. */
export const SECTION_COUNT = 4;
export const SECTION_NAMES = ['A', 'B', 'C', 'D'] as const;
/** The sequencer runs in 16th notes: 4 steps per beat, 4 beats per bar. */
export const STEPS_PER_BEAT = 4;
export const BEATS_PER_BAR = 4;
export const STEPS_PER_BAR = STEPS_PER_BEAT * BEATS_PER_BAR;
export const SECTION_LENGTHS = [8, 12, 16, 24, 32, 48, 64] as const;
export const MIN_LENGTH = 4;
export const MAX_LENGTH = 64;

export const BPM_MIN = 40;
export const BPM_MAX = 240;
/** Swing is stored as the position of the off-beat 16th within its 8th-note pair (0.5 = straight). */
export const SWING_MIN = 0.5;
export const SWING_MAX = 0.75;

/** Step values: 0 = off, 1 = on, 2 = accented. */
export type StepValue = 0 | 1 | 2;

export interface TrackSound {
  /** `builtin:<name>` or `user:<uuid>` */
  sampleId: string;
  /** Linear channel gain, 0..1.5 */
  volume: number;
  /** -1 (left) .. 1 (right) */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Coarse tuning in semitones, -24..24 */
  semitones: number;
  /** Fine tuning in cents, -100..100 */
  cents: number;
  /** Amp attack in seconds, 0..0.25 */
  attack: number;
  /** Amp decay (time to silence after attack) in seconds, 0.02..4 */
  decay: number;
  /** Sample start point as a fraction of the sample length, 0..1 */
  start: number;
  /** Sample end point as a fraction of the sample length, 0..1 (> start) */
  end: number;
  /** Pitch envelope depth in semitones, -24..24 (0 = off) */
  pitchEnvAmount: number;
  /** Pitch envelope time in seconds, 0.005..1 */
  pitchEnvTime: number;
  /** Tone: -1 = dark (low-pass), 0 = neutral, 1 = thin (high-pass) */
  tone: number;
  /** Choke group, 0 = none. Voices in the same group cut each other off. */
  chokeGroup: number;
}

export interface Section {
  length: number;
  steps: Record<TrackId, StepValue[]>;
}

export interface PatternDoc {
  version: 1;
  name: string;
  bpm: number;
  swing: number;
  masterVolume: number;
  activeSection: number;
  sections: Section[];
  tracks: Record<TrackId, TrackSound>;
}

export interface SavedPatternRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  doc: PatternDoc;
}

export interface SampleRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  duration: number;
  createdAt: number;
  /** Original encoded file bytes. Decoded again on load. */
  data: ArrayBuffer;
}

export type SampleMeta = Omit<SampleRecord, 'data'>;

export interface SessionData {
  doc: PatternDoc;
  currentPatternId: string | null;
  selectedTrack: TrackId;
}
