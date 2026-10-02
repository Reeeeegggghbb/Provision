import { blankPattern, defaultTrackSound, emptySection } from './defaults';
import {
  BPM_MAX,
  BPM_MIN,
  MAX_LENGTH,
  MIN_LENGTH,
  SECTION_COUNT,
  SWING_MAX,
  SWING_MIN,
  TRACK_IDS,
  type PatternDoc,
  type Section,
  type StepValue,
  type TrackId,
  type TrackSound,
} from './types';

export type ValidationResult<T> = { ok: true; value: T; warnings: string[] } | { ok: false; error: string };

export const EXPORT_FORMAT = 'drum-machine-pattern';
export const EXPORT_VERSION = 1;

export interface ExportedSample {
  id: string;
  name: string;
  mimeType: string;
  /** Base64-encoded original file bytes */
  data: string;
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  pattern: PatternDoc;
  samples: ExportedSample[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Read a finite number, clamping into range; falls back (with a warning) when missing or invalid. */
function num(
  obj: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
  where: string,
  integer = false,
): number {
  const raw = obj[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    warnings.push(`${where}: "${key}" was not a valid number; using default.`);
    return fallback;
  }
  let v = integer ? Math.round(raw) : raw;
  if (v < min || v > max) {
    warnings.push(`${where}: "${key}" was out of range and has been clamped.`);
    v = clamp(v, min, max);
  }
  return v;
}

function bool(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof obj[key] === 'boolean' ? (obj[key] as boolean) : fallback;
}

const SAMPLE_ID_RE = /^(builtin:[a-z0-9-]+|user:[A-Za-z0-9-]+)$/;

export function validateTrackSound(raw: unknown, track: TrackId, warnings: string[]): TrackSound {
  const d = defaultTrackSound(track);
  if (!isObject(raw)) {
    if (raw !== undefined) warnings.push(`Track "${track}" settings were invalid; defaults restored.`);
    return d;
  }
  const w = `Track "${track}"`;
  let sampleId = d.sampleId;
  if (typeof raw.sampleId === 'string' && SAMPLE_ID_RE.test(raw.sampleId)) sampleId = raw.sampleId;
  else if (raw.sampleId !== undefined) warnings.push(`${w}: unknown sample reference; default sample used.`);

  let start = num(raw, 'start', d.start, 0, 1, warnings, w);
  let end = num(raw, 'end', d.end, 0, 1, warnings, w);
  if (end - start < 0.001) {
    warnings.push(`${w}: sample end was before start; region reset.`);
    start = 0;
    end = 1;
  }
  return {
    sampleId,
    volume: num(raw, 'volume', d.volume, 0, 1.5, warnings, w),
    pan: num(raw, 'pan', d.pan, -1, 1, warnings, w),
    mute: bool(raw, 'mute', d.mute),
    solo: bool(raw, 'solo', d.solo),
    semitones: num(raw, 'semitones', d.semitones, -24, 24, warnings, w, true),
    cents: num(raw, 'cents', d.cents, -100, 100, warnings, w, true),
    attack: num(raw, 'attack', d.attack, 0, 0.25, warnings, w),
    decay: num(raw, 'decay', d.decay, 0.02, 4, warnings, w),
    start,
    end,
    pitchEnvAmount: num(raw, 'pitchEnvAmount', d.pitchEnvAmount, -24, 24, warnings, w),
    pitchEnvTime: num(raw, 'pitchEnvTime', d.pitchEnvTime, 0.005, 1, warnings, w),
    tone: num(raw, 'tone', d.tone, -1, 1, warnings, w),
    chokeGroup: num(raw, 'chokeGroup', d.chokeGroup, 0, 4, warnings, w, true),
  };
}

function validateSection(raw: unknown, index: number, warnings: string[]): Section {
  if (!isObject(raw)) {
    warnings.push(`Section ${index + 1} was missing or invalid; it has been cleared.`);
    return emptySection(16);
  }
  const where = `Section ${index + 1}`;
  let length = num(raw, 'length', 16, MIN_LENGTH, MAX_LENGTH, warnings, where, true);
  if (length % 2 !== 0) {
    length += 1;
    warnings.push(`${where}: odd length rounded up to ${length}.`);
  }
  const section = emptySection(length);
  const steps = isObject(raw.steps) ? raw.steps : {};
  if (!isObject(raw.steps)) warnings.push(`${where}: step data missing; section cleared.`);
  for (const track of TRACK_IDS) {
    const row = steps[track];
    if (row === undefined) continue;
    if (!Array.isArray(row)) {
      warnings.push(`${where}: steps for "${track}" were invalid and have been cleared.`);
      continue;
    }
    section.steps[track] = section.steps[track].map((_, i): StepValue => {
      const v = row[i];
      if (v === 2) return 2;
      if (v === 1 || v === true) return 1;
      return 0;
    });
  }
  return section;
}

/**
 * Validate and normalise a pattern document. Structural problems (not an object, unsupported
 * version) are fatal; out-of-range or missing values are repaired with warnings.
 */
export function validatePatternDoc(raw: unknown): ValidationResult<PatternDoc> {
  if (!isObject(raw)) return { ok: false, error: 'Pattern data is not an object.' };
  if (raw.version !== undefined && raw.version !== 1) {
    return { ok: false, error: `Unsupported pattern version: ${String(raw.version)}.` };
  }
  const rawSections = raw.sections;
  if (!Array.isArray(rawSections)) return { ok: false, error: 'Pattern has no sections.' };

  const warnings: string[] = [];
  const base = blankPattern();
  const name =
    typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : (warnings.push('Pattern name missing.'), 'Untitled');
  const sections = Array.from({ length: SECTION_COUNT }, (_, i) =>
    i < rawSections.length ? validateSection(rawSections[i], i, warnings) : emptySection(16),
  );
  const tracksRaw = isObject(raw.tracks) ? raw.tracks : {};
  if (!isObject(raw.tracks)) warnings.push('Track settings missing; defaults used.');
  const tracks = Object.fromEntries(
    TRACK_IDS.map((t) => [t, validateTrackSound(tracksRaw[t], t, warnings)]),
  ) as Record<TrackId, TrackSound>;

  return {
    ok: true,
    warnings,
    value: {
      version: 1,
      name,
      bpm: num(raw, 'bpm', base.bpm, BPM_MIN, BPM_MAX, warnings, 'Pattern'),
      swing: num(raw, 'swing', base.swing, SWING_MIN, SWING_MAX, warnings, 'Pattern'),
      masterVolume: num(raw, 'masterVolume', base.masterVolume, 0, 1.5, warnings, 'Pattern'),
      activeSection: num(raw, 'activeSection', 0, 0, SECTION_COUNT - 1, warnings, 'Pattern', true),
      sections,
      tracks,
    },
  };
}

/** Validate an exported JSON file (already parsed). Accepts a bare pattern document as well. */
export function validateExportFile(
  raw: unknown,
): ValidationResult<{ pattern: PatternDoc; samples: ExportedSample[] }> {
  if (!isObject(raw)) return { ok: false, error: 'File does not contain a JSON object.' };
  let patternRaw: unknown = raw;
  let samplesRaw: unknown = [];
  if (raw.format !== undefined) {
    if (raw.format !== EXPORT_FORMAT) return { ok: false, error: 'This JSON file is not a drum machine pattern.' };
    if (typeof raw.version !== 'number' || raw.version > EXPORT_VERSION) {
      return { ok: false, error: 'This pattern was exported by a newer, incompatible version.' };
    }
    patternRaw = raw.pattern;
    samplesRaw = raw.samples ?? [];
  }
  const result = validatePatternDoc(patternRaw);
  if (!result.ok) return result;
  const warnings = [...result.warnings];
  const samples: ExportedSample[] = [];
  if (Array.isArray(samplesRaw)) {
    for (const s of samplesRaw) {
      if (
        isObject(s) &&
        typeof s.id === 'string' &&
        /^user:[A-Za-z0-9-]+$/.test(s.id) &&
        typeof s.name === 'string' &&
        typeof s.data === 'string'
      ) {
        samples.push({
          id: s.id,
          name: s.name.slice(0, 200),
          mimeType: typeof s.mimeType === 'string' ? s.mimeType : '',
          data: s.data,
        });
      } else {
        warnings.push('An embedded sample was invalid and was skipped.');
      }
    }
  }
  return { ok: true, value: { pattern: result.value, samples }, warnings };
}

export function parseJson(text: string): ValidationResult<unknown> {
  if (!text.trim()) return { ok: false, error: 'The file is empty.' };
  try {
    return { ok: true, value: JSON.parse(text), warnings: [] };
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
}
