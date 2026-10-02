import { describe, expect, it } from 'vitest';
import { blankPattern } from '../../src/model/defaults';
import { examplePatterns, parseSteps } from '../../src/model/examples';
import { TRACK_IDS } from '../../src/model/types';
import { EXPORT_FORMAT, parseJson, validateExportFile, validatePatternDoc } from '../../src/model/validate';

describe('validatePatternDoc', () => {
  it('accepts every example pattern unchanged', () => {
    for (const ex of examplePatterns()) {
      const r = validatePatternDoc(JSON.parse(JSON.stringify(ex)));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.warnings).toEqual([]);
        expect(r.value).toEqual(ex);
      }
    }
  });

  it.each([
    [null, /not an object/],
    ['pattern', /not an object/],
    [[1, 2], /not an object/],
    [{ version: 99, sections: [] }, /Unsupported/],
    [{ name: 'x' }, /no sections/],
    [{ sections: 'abc' }, /no sections/],
  ])('rejects structurally invalid data %#', (raw, msg) => {
    const r = validatePatternDoc(raw);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(msg);
  });

  it('repairs out-of-range and wrong-typed values with warnings', () => {
    const doc = JSON.parse(JSON.stringify(blankPattern('Test'))) as Record<string, unknown> & ReturnType<typeof blankPattern>;
    doc.bpm = 999;
    doc.swing = 'lots' as unknown as number;
    doc.tracks.kick.semitones = 100;
    doc.tracks.kick.volume = -3;
    doc.tracks.snare.sampleId = 'https://evil.example/x.wav';
    doc.tracks.clap.start = 0.8;
    doc.tracks.clap.end = 0.2;
    (doc.tracks as Record<string, unknown>).rim = 'broken';
    doc.sections[0].length = 13;
    doc.sections[0].steps.kick = [1, 2, 3, 'x', true, null] as never;
    (doc.sections[1].steps as Record<string, unknown>).snare = 'nope';
    const r = validatePatternDoc(doc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value;
    expect(v.bpm).toBe(240);
    expect(v.swing).toBe(0.5);
    expect(v.tracks.kick.semitones).toBe(24);
    expect(v.tracks.kick.volume).toBe(0);
    expect(v.tracks.snare.sampleId).toBe('builtin:snare-classic');
    expect([v.tracks.clap.start, v.tracks.clap.end]).toEqual([0, 1]);
    expect(v.tracks.rim.sampleId).toBe('builtin:rimshot');
    expect(v.sections[0].length).toBe(14);
    expect(v.sections[0].steps.kick.slice(0, 6)).toEqual([1, 2, 0, 0, 1, 0]);
    expect(v.sections[0].steps.kick).toHaveLength(14);
    expect(v.sections[1].steps.snare.every((s) => s === 0)).toBe(true);
    expect(r.warnings.length).toBeGreaterThanOrEqual(8);
  });

  it('fills missing sections and tracks', () => {
    const r = validatePatternDoc({ name: 'Sparse', sections: [{ length: 32, steps: { kick: [1] } }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sections).toHaveLength(4);
    expect(r.value.sections[0].length).toBe(32);
    expect(r.value.sections[3].length).toBe(16);
    for (const t of TRACK_IDS) expect(r.value.tracks[t]).toBeDefined();
  });

  it('clamps section lengths into 4..64', () => {
    const r = validatePatternDoc({ sections: [{ length: 1000, steps: {} }, { length: -5, steps: {} }] });
    expect(r.ok && [r.value.sections[0].length, r.value.sections[1].length]).toEqual([64, 4]);
  });
});

describe('export files', () => {
  it('accepts a well-formed export with embedded samples', () => {
    const r = validateExportFile({
      format: EXPORT_FORMAT,
      version: 1,
      pattern: blankPattern('X'),
      samples: [{ id: 'user:abc-123', name: 'kick.wav', mimeType: 'audio/wav', data: 'AAAA' }],
    });
    expect(r.ok && r.value.samples).toHaveLength(1);
  });

  it('accepts a bare pattern document', () => {
    expect(validateExportFile(blankPattern('Bare')).ok).toBe(true);
  });

  it('skips invalid embedded samples with a warning', () => {
    const r = validateExportFile({
      format: EXPORT_FORMAT,
      version: 1,
      pattern: blankPattern(),
      samples: [{ id: 'builtin:kick', name: 'x', data: 'AA' }, { id: 'user:ok', name: 'y', data: 42 }, 'junk'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.samples).toHaveLength(0);
      expect(r.warnings).toHaveLength(3);
    }
  });

  it('rejects other formats and newer versions', () => {
    expect(validateExportFile({ format: 'something-else', pattern: {} }).ok).toBe(false);
    expect(validateExportFile({ format: EXPORT_FORMAT, version: 2, pattern: blankPattern() }).ok).toBe(false);
    expect(validateExportFile([]).ok).toBe(false);
  });

  it('parses JSON safely', () => {
    expect(parseJson('').ok).toBe(false);
    expect(parseJson('{oops').ok).toBe(false);
    expect(parseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 }, warnings: [] });
  });
});

describe('parseSteps', () => {
  it('parses compact step strings', () => {
    expect(parseSteps('x.X.|..x.')).toEqual([1, 0, 2, 0, 0, 0, 1, 0]);
  });
});
