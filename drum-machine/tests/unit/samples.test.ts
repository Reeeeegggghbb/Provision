import { describe, expect, it } from 'vitest';
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  computePeaks,
  fileExtension,
  loadSampleFile,
  MAX_FILE_BYTES,
  validateAudioFile,
  validateDecoded,
} from '../../src/audio/samples';
import { BUILTIN_SOUNDS, renderBuiltin, rng } from '../../src/audio/synth';
import { defaultDecode, FakeBuffer, fakeAudioBytes, fakeFile } from './fakes';

const decode = async (data: ArrayBuffer) => {
  const r = defaultDecode(data);
  if (r instanceof Error) throw r;
  return r;
};

describe('file validation', () => {
  it.each([
    ['kick.wav', 'audio/wav'],
    ['snare.MP3', 'audio/mpeg'],
    ['hat.ogg', 'audio/ogg'],
    ['clap.flac', ''],
    ['rim.m4a', 'audio/mp4'],
    ['tom.aiff', ''],
    ['perc.opus', ''],
    ['weird-name', 'audio/x-custom'],
  ])('accepts %s (%s)', (name, type) => {
    expect(validateAudioFile({ name, size: 1000, type })).toEqual({ ok: true });
  });

  it('rejects empty files', () => {
    const r = validateAudioFile({ name: 'a.wav', size: 0, type: 'audio/wav' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/empty/);
  });

  it('rejects excessively large files', () => {
    const r = validateAudioFile({ name: 'a.wav', size: MAX_FILE_BYTES + 1, type: 'audio/wav' });
    expect(!r.ok && r.error).toMatch(/limit/);
  });

  it('rejects non-audio files', () => {
    for (const [name, type] of [
      ['photo.png', 'image/png'],
      ['notes.txt', 'text/plain'],
      ['archive.zip', 'application/zip'],
      ['noext', ''],
    ]) {
      expect(validateAudioFile({ name, size: 10, type }).ok).toBe(false);
    }
  });

  it('extracts extensions', () => {
    expect(fileExtension('a.b.WAV')).toBe('wav');
    expect(fileExtension('none')).toBe('');
  });

  it('rejects decoded audio that is empty or too long', () => {
    expect(validateDecoded('x', new FakeBuffer(1, 0, 48000)).ok).toBe(false);
    expect(validateDecoded('x', new FakeBuffer(1, 48000 * 31, 48000)).ok).toBe(false);
    expect(validateDecoded('x', new FakeBuffer(1, 48000, 48000)).ok).toBe(true);
  });
});

describe('loadSampleFile', () => {
  it('decodes a valid file and prepares a preview', async () => {
    const r = await loadSampleFile(fakeFile(fakeAudioBytes(0.4), 'kick.wav'), decode);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sample.name).toBe('kick.wav');
    expect(r.sample.buffer.duration).toBeCloseTo(0.4, 6);
    expect(r.sample.peaks.length).toBe(800);
    expect(r.sample.data.byteLength).toBe(16);
  });

  it('reports decoding failures (corrupt or unsupported data) without throwing', async () => {
    const r = await loadSampleFile(fakeFile('garbage data!!!!', 'broken.wav'), decode);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/could not decode/);
  });

  it('rejects files whose decoded length exceeds the limit', async () => {
    const r = await loadSampleFile(fakeFile(fakeAudioBytes(45), 'long.wav'), decode);
    expect(!r.ok && r.error).toMatch(/limited to 30 s/);
  });

  it('rejects files that decode to no audio', async () => {
    const r = await loadSampleFile(fakeFile(fakeAudioBytes(0), 'silent.wav'), decode);
    expect(!r.ok && r.error).toMatch(/no audio/);
  });

  it('rejects non-audio before decoding', async () => {
    let called = false;
    const r = await loadSampleFile(fakeFile('hello', 'readme.txt', 'text/plain'), async () => {
      called = true;
      throw new Error();
    });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('waveform peaks', () => {
  it('computes min/max per bucket across channels', () => {
    const b = new FakeBuffer(2, 8, 8);
    b.getChannelData(0).set([1, -1, 0.5, 0.5, 0, 0, 0, 0]);
    b.getChannelData(1).set([1, -1, 0.5, 0.5, 0, 0, 0, 0]);
    const p = computePeaks(b, 4);
    expect([...p]).toEqual([-1, 1, 0.5, 0.5, 0, 0, 0, 0]);
  });

  it('handles empty buffers', () => {
    expect([...computePeaks(new FakeBuffer(1, 0, 8), 4)]).toEqual(new Array(8).fill(0));
  });
});

describe('encoding helpers', () => {
  it('round-trips binary data through base64', () => {
    const bytes = new Uint8Array(70000).map((_, i) => (i * 31) % 256);
    const back = new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(bytes.buffer)));
    expect(back).toEqual(bytes);
  });
});

describe('built-in synthesised kit', () => {
  it('is deterministic', () => {
    const a = rng(5);
    const b = rng(5);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });

  it('renders every sound normalised, finite and click-free at the ends', () => {
    for (const s of BUILTIN_SOUNDS) {
      const pcm = renderBuiltin(s.id)!;
      expect(pcm.length).toBeGreaterThan(1000);
      let peak = 0;
      for (const v of pcm) {
        expect(Number.isFinite(v)).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
      expect(peak).toBeCloseTo(0.9, 3);
      expect(Math.abs(pcm[0])).toBeLessThan(0.01);
      expect(Math.abs(pcm[pcm.length - 1])).toBeLessThan(0.01);
    }
  });

  it('caches rendered sounds', () => {
    expect(renderBuiltin('builtin:clap')).toBe(renderBuiltin('builtin:clap'));
    expect(renderBuiltin('builtin:nope')).toBeNull();
  });
});
