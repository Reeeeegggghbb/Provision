import { describe, expect, it } from 'vitest';
import { blankPattern } from '../../src/model/defaults';
import type { SavedPatternRecord } from '../../src/model/types';
import { MemoryStorage } from '../../src/storage/storage';
import { fakeAudioBytes, fakeFile } from './fakes';
import { flush, makeRig } from './helpers';

describe('start-up and persistence', () => {
  it('seeds the example patterns and loads one on first run', async () => {
    const { c } = await makeRig();
    expect(c.state.savedPatterns.map((p) => p.name)).toEqual(['Boom Bap', 'Breakbeat', 'Electro Funk', 'House Groove']);
    expect(c.state.currentPatternId).toBe('example-boom-bap');
    expect(c.state.doc.bpm).toBe(90);
    expect(c.state.dirty).toBe(false);
  });

  it('restores the working session after a refresh, including unsaved edits', async () => {
    const storage = new MemoryStorage();
    const a = await makeRig({ storage });
    a.c.toggleStep('tom', 3);
    a.c.setBpm(133);
    a.c.setSwing(0.6);
    a.c.setTrackParam('snare', 'semitones', -3);
    a.c.selectSection(2);
    a.c.selectTrack('clap');
    await flush();

    const b = await makeRig({ storage });
    expect(b.c.state.doc.bpm).toBe(133);
    expect(b.c.state.doc.swing).toBe(0.6);
    expect(b.c.state.doc.tracks.snare.semitones).toBe(-3);
    expect(b.c.state.doc.sections[0].steps.tom[3]).toBe(1);
    expect(b.c.state.doc.activeSection).toBe(2);
    expect(b.c.state.selectedTrack).toBe('clap');
    expect(b.c.state.dirty).toBe(true);
    expect(b.c.sequencer.tempo).toBe(133);
    expect(b.c.sequencer.section).toBe(2);
  });

  it('recovers from a corrupted session without crashing', async () => {
    const storage = new MemoryStorage();
    storage.session = { doc: 'garbage', currentPatternId: 5 };
    const { c, toasts } = await makeRig({ storage });
    expect(c.state.doc.name).toBe('Boom Bap');
    expect(toasts.some(([m, k]) => k === 'warning' && /corrupted/.test(m))).toBe(true);
  });

  it('repairs partially invalid session data', async () => {
    const storage = new MemoryStorage();
    const doc = blankPattern('Partial') as unknown as Record<string, unknown>;
    doc.bpm = 9000;
    storage.session = { doc, currentPatternId: null, selectedTrack: 'nonsense' };
    const { c, toasts } = await makeRig({ storage });
    expect(c.state.doc.bpm).toBe(240);
    expect(c.state.selectedTrack).toBe('kick');
    expect(toasts.some(([, k]) => k === 'warning')).toBe(true);
  });

  it('survives a storage backend that throws', async () => {
    const storage = new MemoryStorage();
    storage.listPatterns = async () => {
      throw new Error('quota');
    };
    storage.getSession = async () => {
      throw new Error('broken');
    };
    const { c, toasts } = await makeRig({ storage });
    expect(c.state.doc).toBeDefined();
    expect(toasts.some(([, k]) => k === 'error')).toBe(true);
  });

  it('warns that nothing persists when only in-memory storage is available', async () => {
    const { toasts } = await makeRig();
    expect(toasts.some(([m]) => /storage is unavailable/.test(m))).toBe(true);
  });
});

describe('pattern library', () => {
  it('saves a new pattern under a custom name and reloads it', async () => {
    const { c } = await makeRig();
    c.newBlankPattern();
    c.toggleStep('kick', 0);
    c.setBpm(101);
    expect(await c.saveAs('  My Beat  ')).toBe(true);
    expect(c.state.doc.name).toBe('My Beat');
    expect(c.state.dirty).toBe(false);
    const id = c.state.currentPatternId!;

    c.toggleStep('kick', 0);
    c.setBpm(150);
    expect(c.state.dirty).toBe(true);
    expect(await c.loadPattern(id)).toBe(true);
    expect(c.state.doc.bpm).toBe(101);
    expect(c.state.doc.sections[0].steps.kick[0]).toBe(1);
  });

  it('save overwrites the current entry', async () => {
    const { c, storage } = await makeRig();
    const id = c.state.currentPatternId!;
    c.setBpm(77);
    await c.save();
    const rec = (await storage.getPattern(id)) as SavedPatternRecord;
    expect(rec.doc.bpm).toBe(77);
    expect(c.state.savedPatterns).toHaveLength(4);
  });

  it('preserves track settings, mute/solo and sample assignments', async () => {
    const { c } = await makeRig();
    c.setTrackParam('kick', 'decay', 0.3);
    c.setTrackParam('kick', 'pitchEnvAmount', 7);
    c.toggleMute('clap');
    c.toggleSolo('snare');
    c.setTrackSample('tom', 'builtin:tom-high');
    await c.saveAs('Settings');
    const id = c.state.currentPatternId!;
    c.newBlankPattern();
    await c.loadPattern(id);
    const t = c.state.doc.tracks;
    expect([t.kick.decay, t.kick.pitchEnvAmount, t.clap.mute, t.snare.solo, t.tom.sampleId]).toEqual([0.3, 7, true, true, 'builtin:tom-high']);
  });

  it('renames, duplicates and deletes', async () => {
    const { c } = await makeRig();
    const id = c.state.currentPatternId!;
    await c.renamePattern(id, 'Renamed');
    expect(c.state.doc.name).toBe('Renamed');
    expect(c.state.savedPatterns.find((p) => p.id === id)!.name).toBe('Renamed');

    const dup = await c.duplicatePattern(id);
    expect(c.state.savedPatterns.find((p) => p.id === dup)!.name).toBe('Renamed copy');
    const dup2 = await c.duplicatePattern(id);
    expect(c.state.savedPatterns.find((p) => p.id === dup2)!.name).toBe('Renamed copy 2');

    await c.deletePattern(id);
    expect(c.state.savedPatterns.some((p) => p.id === id)).toBe(false);
    expect(c.state.currentPatternId).toBeNull();
    expect(c.state.doc.name).toBe('Renamed'); // working copy is kept
  });

  it('flags corrupted saved patterns and refuses to load them', async () => {
    const storage = new MemoryStorage();
    storage.patterns.set('bad', { id: 'bad', name: 'Broken', doc: { sections: 'x' } });
    const { c, toasts } = await makeRig({ storage });
    const bad = c.state.savedPatterns.find((p) => p.id === 'bad')!;
    expect(bad.corrupt).toBe(true);
    const before = c.state.doc;
    expect(await c.loadPattern('bad')).toBe(false);
    expect(c.state.doc).toBe(before);
    expect(toasts.some(([m, k]) => k === 'error' && /corrupted/.test(m))).toBe(true);
    expect(await c.duplicatePattern('bad')).toBeNull();
    await c.deletePattern('bad');
    expect(c.state.savedPatterns.some((p) => p.id === 'bad')).toBe(false);
  });

  it('restores examples without duplicating them', async () => {
    const { c } = await makeRig();
    await c.deletePattern('example-house-groove');
    await c.restoreExamples();
    await c.restoreExamples();
    expect(c.state.savedPatterns.filter((p) => p.name === 'House Groove')).toHaveLength(1);
  });

  it('starts a blank pattern', async () => {
    const { c } = await makeRig();
    c.newBlankPattern();
    expect(c.state.currentPatternId).toBeNull();
    expect(c.state.doc.sections.every((s) => Object.values(s.steps).every((r) => r.every((v) => v === 0)))).toBe(true);
  });
});

describe('sections and steps', () => {
  it('switches between independent sections', async () => {
    const { c } = await makeRig();
    c.newBlankPattern();
    c.toggleStep('kick', 0);
    c.selectSection(1);
    expect(c.state.doc.sections[1].steps.kick[0]).toBe(0);
    c.toggleStep('snare', 4);
    c.selectSection(0);
    expect(c.state.doc.sections[0].steps.snare[4]).toBe(0);
    expect(c.state.doc.sections[0].steps.kick[0]).toBe(1);
  });

  it('toggles normal and accented steps', async () => {
    const { c } = await makeRig();
    c.newBlankPattern();
    expect(c.toggleStep('kick', 2)).toBe(1);
    expect(c.toggleStep('kick', 2, true)).toBe(2);
    expect(c.toggleStep('kick', 2, true)).toBe(1);
    expect(c.toggleStep('kick', 2)).toBe(0);
  });

  it('resizes, copies and clears sections', async () => {
    const { c } = await makeRig();
    c.newBlankPattern();
    c.toggleStep('kick', 15);
    c.setSectionLength(32);
    expect(c.state.doc.sections[0].steps.kick).toHaveLength(32);
    expect(c.state.doc.sections[0].steps.kick[15]).toBe(1);
    c.toggleStep('kick', 31);
    c.copySectionTo(3);
    expect(c.state.doc.sections[3].length).toBe(32);
    expect(c.state.doc.sections[3].steps.kick[31]).toBe(1);
    c.setSectionLength(13);
    expect(c.state.doc.sections[0].length).toBe(14);
    c.clearSection();
    expect(c.state.doc.sections[0].steps.kick.every((v) => v === 0)).toBe(true);
  });

  it('clamps tempo and swing', async () => {
    const { c } = await makeRig();
    c.setBpm(10);
    expect(c.state.doc.bpm).toBe(40);
    c.setBpm(500);
    expect(c.state.doc.bpm).toBe(240);
    c.setSwing(0.9);
    expect(c.state.doc.swing).toBe(0.75);
    c.setSwing(NaN);
    expect(c.state.doc.swing).toBe(0.75);
  });
});

describe('transport integration', () => {
  it('resumes audio on play and schedules hits for active steps only', async () => {
    const r = await makeRig();
    const { c } = r;
    c.newBlankPattern();
    c.toggleStep('kick', 0);
    c.toggleStep('snare', 0);
    c.toggleMute('snare');
    expect(await c.play()).toBe(true);
    expect(r.ctx().state).toBe('running');
    expect(c.state.transport).toBe('playing');
    const starts = r.ctx().sources().map((s) => s.started!.when);
    expect(starts).toHaveLength(1); // kick only; muted snare is not scheduled
    expect(starts[0]).toBeCloseTo(0.05, 9);
  });

  it('solo silences other tracks at schedule time', async () => {
    const r = await makeRig();
    r.c.newBlankPattern();
    r.c.toggleStep('kick', 0);
    r.c.toggleStep('clap', 0);
    r.c.toggleSolo('clap');
    await r.c.play();
    expect(r.ctx().sources()).toHaveLength(1);
  });

  it('repeated play/pause/stop does not duplicate scheduling', async () => {
    const r = await makeRig();
    const { c } = r;
    await Promise.all([c.play(), c.play(), c.play()]);
    expect(r.ticker.starts).toBe(1);
    c.pause();
    c.pause();
    await c.play();
    c.stop();
    c.stop();
    expect(c.state.transport).toBe('stopped');
    expect(r.ticker.running).toBe(false);
  });

  it('stop pressed while the context is still resuming wins', async () => {
    const r = await makeRig();
    const p = r.c.play();
    r.c.stop();
    expect(await p).toBe(false);
    expect(r.c.state.transport).toBe('stopped');
  });

  it('reports a context that cannot start', async () => {
    const r = await makeRig({ audio: { resumeFails: true } });
    expect(await r.c.play()).toBe(false);
    expect(r.toasts.some(([, k]) => k === 'error')).toBe(true);
    expect(r.c.state.transport).toBe('stopped');
  });

  it('pauses when the browser interrupts audio', async () => {
    const r = await makeRig();
    await r.c.play();
    r.ctx().setState('interrupted');
    expect(r.c.state.transport).toBe('paused');
    expect(r.toasts.some(([m]) => /interrupted/.test(m))).toBe(true);
  });

  it('applies tempo changes to the running sequencer', async () => {
    const r = await makeRig();
    await r.c.play();
    r.c.setBpm(180);
    expect(r.c.sequencer.tempo).toBe(180);
  });

  it('section selection is queued while playing and followed by the view when audible', async () => {
    const r = await makeRig();
    await r.c.play();
    r.c.selectSection(1);
    expect(r.c.state.queuedSection).toBe(1);
    expect(r.c.state.doc.activeSection).toBe(0);
    const ctx = r.ctx();
    for (let i = 0; i < 400 && r.c.state.doc.activeSection === 0; i++) {
      ctx.currentTime += 0.025;
      r.ticker.fire();
      r.c.playhead();
    }
    expect(r.c.state.doc.activeSection).toBe(1);
    expect(r.c.state.queuedSection).toBeNull();
  });

  it('enlarges the lookahead while the tab is hidden', async () => {
    const { c } = await makeRig();
    c.setHidden(true);
    expect(c.sequencer.lookahead).toBe(1);
    c.setHidden(false);
    expect(c.sequencer.lookahead).toBeCloseTo(0.12);
  });
});

describe('track settings', () => {
  it('changes tuning and resets to defaults (keeping mute/solo)', async () => {
    const { c } = await makeRig();
    c.setTrackParam('kick', 'semitones', 5);
    c.setTrackParam('kick', 'cents', -20);
    c.setTrackParam('kick', 'tone', -0.5);
    c.toggleMute('kick');
    c.resetTrack('kick');
    const k = c.state.doc.tracks.kick;
    expect([k.semitones, k.cents, k.tone, k.mute]).toEqual([0, 0, 0, true]);
  });

  it('keeps start before end', async () => {
    const { c } = await makeRig();
    c.setTrackParam('snare', 'end', 0.3);
    c.setTrackParam('snare', 'start', 0.9);
    const s = c.state.doc.tracks.snare;
    expect(s.end - s.start).toBeGreaterThan(0);
  });

  it('auditions through the engine after resuming audio', async () => {
    const r = await makeRig();
    await r.c.audition('clap');
    expect(r.ctx().sources()).toHaveLength(1);
  });
});

describe('custom samples', () => {
  it('imports, previews, assigns and persists a sample', async () => {
    const storage = new MemoryStorage();
    const r = await makeRig({ storage });
    const ok = await r.c.importSampleFile('snare', fakeFile(fakeAudioBytes(0.3), 'my snare.wav'));
    expect(ok).toBe(true);
    expect(r.c.state.pending!.sample.name).toBe('my snare.wav');
    expect(await storage.listSampleMeta()).toHaveLength(0); // nothing stored before assigning

    await r.c.previewPending();
    expect(r.ctx().sources()).toHaveLength(1);

    expect(await r.c.assignPending()).toBe(true);
    const id = r.c.state.doc.tracks.snare.sampleId;
    expect(id).toMatch(/^user:/);
    expect(r.c.state.pending).toBeNull();
    expect(r.c.sampleName(id)).toBe('my snare.wav');
    expect(r.c.peaks(id)).not.toBeNull();
    await flush();

    // After a refresh the sample is decoded from IndexedDB again and still assigned.
    const r2 = await makeRig({ storage });
    expect(r2.c.state.doc.tracks.snare.sampleId).toBe(id);
    expect(r2.c.engine.getBuffer(id)!.duration).toBeCloseTo(0.3, 6);
  });

  it('replaces and removes a track sample', async () => {
    const r = await makeRig();
    await r.c.importSampleFile('kick', fakeFile(fakeAudioBytes(0.2), 'a.wav'));
    await r.c.assignPending();
    const first = r.c.state.doc.tracks.kick.sampleId;
    await r.c.importSampleFile('kick', fakeFile(fakeAudioBytes(0.4), 'b.wav'));
    await r.c.assignPending();
    const second = r.c.state.doc.tracks.kick.sampleId;
    expect(second).not.toBe(first);
    expect(r.c.state.samples).toHaveLength(2);
    r.c.removeTrackSample('kick');
    expect(r.c.state.doc.tracks.kick.sampleId).toBe('builtin:kick-deep');
  });

  it('cancelling a preview stores nothing', async () => {
    const r = await makeRig();
    await r.c.importSampleFile('kick', fakeFile(fakeAudioBytes(0.2), 'a.wav'));
    r.c.cancelPending();
    expect(r.c.state.pending).toBeNull();
    expect(await r.storage.listSampleMeta()).toHaveLength(0);
  });

  it('deleting a sample from the library reverts tracks that use it', async () => {
    const r = await makeRig();
    await r.c.importSampleFile('clap', fakeFile(fakeAudioBytes(0.2), 'c.wav'));
    await r.c.assignPending();
    const id = r.c.state.doc.tracks.clap.sampleId;
    r.c.setTrackSample('rim', id);
    await r.c.deleteSample(id);
    expect(r.c.state.doc.tracks.clap.sampleId).toBe('builtin:clap');
    expect(r.c.state.doc.tracks.rim.sampleId).toBe('builtin:rimshot');
    expect(r.c.engine.getBuffer(id)).toBeUndefined();
    expect(await r.storage.getSample(id)).toBeUndefined();
  });

  it.each([
    ['empty.wav', new ArrayBuffer(0), /empty/],
    ['bad.wav', new TextEncoder().encode('definitely not audio').buffer, /could not decode/],
    ['image.png', fakeAudioBytes(0.2), /does not look like an audio/],
  ])('reports errors for %s', async (name, bytes, msg) => {
    const r = await makeRig();
    const type = name.endsWith('.png') ? 'image/png' : 'audio/wav';
    expect(await r.c.importSampleFile('kick', fakeFile(bytes, name, type))).toBe(false);
    expect(r.toasts.some(([m, k]) => k === 'error' && msg.test(m))).toBe(true);
    expect(r.c.state.pending).toBeNull();
    expect(r.c.state.importing).toBe(false);
  });

  it('falls back to the default sound when a stored sample cannot be decoded', async () => {
    const storage = new MemoryStorage();
    await storage.putSample({ id: 'user:zzz', name: 'z.wav', mimeType: 'audio/wav', size: 3, duration: 1, createdAt: 0, data: new Uint8Array([1, 2, 3]).buffer });
    const doc = blankPattern('Uses broken');
    doc.tracks.kick.sampleId = 'user:zzz';
    storage.session = { doc, currentPatternId: null };
    const r = await makeRig({ storage });
    expect(r.c.state.brokenSamples.has('user:zzz')).toBe(true);
    expect(r.c.state.doc.tracks.kick.sampleId).toBe('builtin:kick-deep');
  });

  it('handles a storage failure while assigning', async () => {
    const storage = new MemoryStorage();
    storage.putSample = async () => {
      throw new Error('QuotaExceededError');
    };
    const r = await makeRig({ storage });
    const before = r.c.state.doc.tracks.kick.sampleId;
    await r.c.importSampleFile('kick', fakeFile(fakeAudioBytes(0.2), 'a.wav'));
    expect(await r.c.assignPending()).toBe(false);
    expect(r.c.state.doc.tracks.kick.sampleId).toBe(before);
    expect(r.toasts.some(([m, k]) => k === 'error' && /could not be saved/.test(m))).toBe(true);
  });
});

describe('JSON export / import', () => {
  it('round-trips a pattern with an embedded custom sample into a fresh browser', async () => {
    const a = await makeRig();
    await a.c.importSampleFile('tom', fakeFile(fakeAudioBytes(0.25), 'tom.wav'));
    await a.c.assignPending();
    a.c.setBpm(111);
    a.c.toggleStep('tom', 5);
    const json = await a.c.exportJson(true);
    const parsed = JSON.parse(json);
    expect(parsed.format).toBe('drum-machine-pattern');
    expect(parsed.samples).toHaveLength(1);

    const b = await makeRig();
    expect(await b.c.importJson(json)).toBe(true);
    expect(b.c.state.doc.bpm).toBe(111);
    expect(b.c.state.doc.tracks.tom.sampleId).toBe(a.c.state.doc.tracks.tom.sampleId);
    expect(b.c.engine.getBuffer(b.c.state.doc.tracks.tom.sampleId)).toBeDefined();
    expect(b.c.state.currentPatternId).toBeNull();
    expect(b.c.state.dirty).toBe(true);
  });

  it('without embedded samples, missing ones fall back to defaults with a warning', async () => {
    const a = await makeRig();
    await a.c.importSampleFile('tom', fakeFile(fakeAudioBytes(0.25), 'tom.wav'));
    await a.c.assignPending();
    const json = await a.c.exportJson(false);
    const b = await makeRig();
    await b.c.importJson(json);
    expect(b.c.state.doc.tracks.tom.sampleId).toBe('builtin:tom-low');
    expect(b.toasts.some(([m]) => /Missing samples on Tom/.test(m))).toBe(true);
  });

  it.each([
    ['', /empty/],
    ['{not json', /not valid JSON/],
    ['[1,2,3]', /not contain a JSON object/],
    ['{"format":"other"}', /not a drum machine pattern/],
    ['{"format":"drum-machine-pattern","version":7,"pattern":{}}', /newer/],
  ])('rejects invalid import %#', async (text, msg) => {
    const r = await makeRig();
    const before = r.c.state.doc;
    expect(await r.c.importJson(text)).toBe(false);
    expect(r.c.state.doc).toBe(before);
    expect(r.toasts.some(([m, k]) => k === 'error' && msg.test(m))).toBe(true);
  });

  it('skips undecodable embedded samples', async () => {
    const r = await makeRig();
    const doc = blankPattern('With bad sample');
    doc.tracks.kick.sampleId = 'user:bad';
    const json = JSON.stringify({ format: 'drum-machine-pattern', version: 1, pattern: doc, samples: [{ id: 'user:bad', name: 'b', mimeType: '', data: btoa('xxxxxxxxxx') }] });
    expect(await r.c.importJson(json)).toBe(true);
    expect(r.c.state.doc.tracks.kick.sampleId).toBe('builtin:kick-deep');
    expect(r.toasts.some(([m]) => /could not be decoded/.test(m))).toBe(true);
  });
});
