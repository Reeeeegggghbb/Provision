import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountApp, type MountedApp } from '../../src/ui/app';
import { flush, makeRig, type Rig } from './helpers';

let rig: Rig;
let app: MountedApp;
let root: HTMLElement;

beforeEach(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app')!;
  rig = await makeRig();
  rig.c.newBlankPattern();
  app = mountApp(root, rig.c, { raf: false });
});

afterEach(() => {
  app.destroy();
  rig.c.dispose();
});

const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
const step = (track: string, i: number) => q<HTMLButtonElement>(`.grid-row[data-track="${track}"] .step[data-step="${i}"]`);
const byLabel = (label: string) => q<HTMLButtonElement>(`[aria-label="${label}"]`);
const byText = (sel: string, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>(sel)].find((b) => b.textContent?.trim() === text)!;
const key = (target: EventTarget, k: string, opts: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
function setRange(input: HTMLInputElement, value: number) {
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('step grid', () => {
  it('renders 7 tracks × 16 steps with beat and bar markers', () => {
    expect(root.querySelectorAll('.grid-body .grid-row')).toHaveLength(7);
    expect(root.querySelectorAll('.grid-row[data-track="kick"] .step')).toHaveLength(16);
    expect(step('kick', 0).classList.contains('bar-start')).toBe(true);
    expect(step('kick', 4).classList.contains('beat-start')).toBe(true);
    expect(step('kick', 5).classList.contains('beat-start')).toBe(false);
  });

  it('toggles steps on click and reflects state accessibly', () => {
    const b = step('snare', 4);
    expect(b.getAttribute('aria-pressed')).toBe('false');
    b.click();
    expect(rig.c.state.doc.sections[0].steps.snare[4]).toBe(1);
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(b.classList.contains('on')).toBe(true);
    expect(b.getAttribute('aria-label')).toMatch(/Snare, step 5 \(bar 1 beat 2\), on/);
    b.click();
    expect(rig.c.state.doc.sections[0].steps.snare[4]).toBe(0);
  });

  it('shift-click sets an accent', () => {
    step('kick', 0).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(rig.c.state.doc.sections[0].steps.kick[0]).toBe(2);
    expect(step('kick', 0).classList.contains('accent')).toBe(true);
  });

  it('supports arrow-key navigation with a roving tabindex and A for accent', () => {
    const tabbable = () => root.querySelectorAll('.step[tabindex="0"]');
    expect(tabbable()).toHaveLength(1);
    const first = step('kick', 0);
    first.focus();
    key(first, 'ArrowRight');
    expect(document.activeElement).toBe(step('kick', 1));
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(step('snare', 1));
    key(document.activeElement!, 'ArrowLeft');
    key(document.activeElement!, 'ArrowLeft');
    expect(document.activeElement).toBe(step('snare', 15)); // wraps
    key(document.activeElement!, 'a');
    expect(rig.c.state.doc.sections[0].steps.snare[15]).toBe(2);
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toBe(step('snare', 15));
  });

  it('grows to 32 steps when the section length changes', () => {
    const sel = q<HTMLSelectElement>('#section-length');
    sel.value = '32';
    sel.dispatchEvent(new Event('change'));
    expect(root.querySelectorAll('.grid-row[data-track="kick"] .step')).toHaveLength(32);
    expect(step('kick', 16).classList.contains('bar-start')).toBe(true);
  });

  it('switches sections with buttons and number keys', () => {
    byText('.section-btn', 'B').click();
    expect(rig.c.state.doc.activeSection).toBe(1);
    expect(byText('.section-btn', 'B').getAttribute('aria-pressed')).toBe('true');
    key(document.body, '4');
    expect(rig.c.state.doc.activeSection).toBe(3);
  });

  it('highlights the playing step', () => {
    app.grid.setPlaying(3);
    expect(step('tom', 3).classList.contains('playing')).toBe(true);
    app.grid.setPlaying(4);
    expect(step('tom', 3).classList.contains('playing')).toBe(false);
    expect(root.querySelectorAll('.step.playing')).toHaveLength(7);
  });
});

describe('mute, solo and volume', () => {
  it('toggles mute and solo from the grid', () => {
    const mute = q<HTMLButtonElement>('.grid-row[data-track="clap"] .ms.mute');
    mute.click();
    expect(rig.c.state.doc.tracks.clap.mute).toBe(true);
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    expect(q('.grid-row[data-track="clap"]').classList.contains('silenced')).toBe(true);

    q<HTMLButtonElement>('.grid-row[data-track="kick"] .ms.solo').click();
    expect(rig.c.state.doc.tracks.kick.solo).toBe(true);
    expect(q('.grid-row[data-track="snare"]').classList.contains('silenced')).toBe(true);
    expect(q('.grid-row[data-track="kick"]').classList.contains('silenced')).toBe(false);
  });

  it('changes track volume from the mixer', () => {
    const input = q<HTMLInputElement>('.strip[data-track="snare"] .strip-volume input');
    setRange(input, 0.5);
    expect(rig.c.state.doc.tracks.snare.volume).toBe(0.5);
    expect(q('.strip[data-track="snare"] .strip-volume output').textContent).toBe('−6.0 dB');
  });
});

describe('tempo and swing controls', () => {
  it('sets the tempo from the number field and clamps it', () => {
    const input = q<HTMLInputElement>('#bpm-input');
    input.value = '128';
    input.dispatchEvent(new Event('change'));
    expect(rig.c.state.doc.bpm).toBe(128);
    input.value = '999';
    input.dispatchEvent(new Event('change'));
    expect(rig.c.state.doc.bpm).toBe(240);
    expect(input.value).toBe('240');
    input.value = '';
    input.dispatchEvent(new Event('change'));
    expect(rig.c.state.doc.bpm).toBe(240);
  });

  it('nudges and slides the tempo', () => {
    rig.c.setBpm(120);
    byLabel('Increase tempo by 1 BPM').click();
    expect(rig.c.state.doc.bpm).toBe(121);
    setRange(q<HTMLInputElement>('.bpm-slider'), 75);
    expect(rig.c.state.doc.bpm).toBe(75);
  });

  it('shows swing as a percentage', () => {
    const input = q<HTMLInputElement>('.swing input');
    setRange(input, 62);
    expect(rig.c.state.doc.swing).toBeCloseTo(0.62);
    expect(q('.swing output').textContent).toBe('62%');
  });
});

describe('transport keyboard and buttons', () => {
  it('Space toggles play/pause, Esc stops, Home rewinds', async () => {
    key(document.body, ' ');
    await flush();
    expect(rig.c.state.transport).toBe('playing');
    expect(byLabel('Play').getAttribute('aria-pressed')).toBe('true');
    key(document.body, ' ');
    expect(rig.c.state.transport).toBe('paused');
    key(document.body, 'Home');
    expect(rig.c.sequencer.nextStep).toBe(0);
    key(document.body, ' ');
    await flush();
    key(document.body, 'Escape');
    expect(rig.c.state.transport).toBe('stopped');
  });

  it('does not hijack Space while typing', async () => {
    const input = q<HTMLInputElement>('#pattern-name');
    input.focus();
    key(input, ' ');
    await flush();
    expect(rig.c.state.transport).toBe('stopped');
  });

  it('transport buttons are labelled and work', async () => {
    byLabel('Play').click();
    await flush();
    expect(rig.c.state.transport).toBe('playing');
    byLabel('Pause').click();
    expect(rig.c.state.transport).toBe('paused');
    byLabel('Stop').click();
    expect(rig.c.state.transport).toBe('stopped');
  });
});

describe('pattern library UI', () => {
  const openLibrary = () => byText('.top-actions .btn', 'Patterns').click();

  it('saves, loads, renames and deletes patterns', async () => {
    openLibrary();
    expect(q('#library').hidden).toBe(false);
    step('kick', 0).click();
    const name = q<HTMLInputElement>('#save-as-name');
    name.value = 'UI Beat';
    q<HTMLFormElement>('.save-as').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(rig.c.state.savedPatterns.some((p) => p.name === 'UI Beat')).toBe(true);
    expect(q<HTMLInputElement>('#pattern-name').value).toBe('UI Beat');

    // Load a different pattern, then the saved one again.
    byLabel('Load House Groove').click();
    await flush();
    expect(rig.c.state.doc.name).toBe('House Groove');
    byLabel('Load UI Beat').click();
    await flush();
    expect(rig.c.state.doc.sections[0].steps.kick[0]).toBe(1);

    // Rename inline
    byLabel('Rename UI Beat').click();
    const field = q<HTMLInputElement>('[aria-label="New name for UI Beat"]');
    field.value = 'Renamed Beat';
    key(field, 'Enter');
    await flush();
    expect(rig.c.state.savedPatterns.some((p) => p.name === 'Renamed Beat')).toBe(true);
    expect(rig.c.state.doc.name).toBe('Renamed Beat');

    // Duplicate
    byLabel('Duplicate Renamed Beat').click();
    await flush();
    expect(rig.c.state.savedPatterns.some((p) => p.name === 'Renamed Beat copy')).toBe(true);

    // Delete requires confirmation
    byLabel('Delete Renamed Beat copy').click();
    expect(rig.c.state.savedPatterns.some((p) => p.name === 'Renamed Beat copy')).toBe(true);
    byLabel('Confirm delete Renamed Beat copy').click();
    await flush();
    expect(rig.c.state.savedPatterns.some((p) => p.name === 'Renamed Beat copy')).toBe(false);
  });

  it('Escape closes the library and Ctrl+S saves', async () => {
    openLibrary();
    key(document.body, 'Escape');
    expect(q('#library').hidden).toBe(true);
    step('tom', 2).click();
    key(document.body, 's', { ctrlKey: true });
    await flush();
    expect(rig.c.state.dirty).toBe(false);
    expect(rig.c.state.currentPatternId).not.toBeNull();
  });

  it('renames the working pattern from the header', async () => {
    const input = q<HTMLInputElement>('#pattern-name');
    input.value = 'Header Name';
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(rig.c.state.doc.name).toBe('Header Name');
  });

  it('shows the unsaved-changes indicator', () => {
    expect(q('.dirty').classList.contains('on')).toBe(false);
    step('kick', 1).click();
    expect(q('.dirty').classList.contains('on')).toBe(true);
  });
});

describe('sound editor', () => {
  it('edits the selected track and resets it', () => {
    byText('.grid-row[data-track="tom"] .track-name', 'Tom').click();
    expect(rig.c.state.selectedTrack).toBe('tom');
    expect(q('#editor-title').textContent).toBe('Tom');
    const pitch = [...root.querySelectorAll<HTMLElement>('.editor .slider')].find((s) => s.textContent?.startsWith('Pitch'))!;
    setRange(pitch.querySelector('input')!, 7);
    expect(rig.c.state.doc.tracks.tom.semitones).toBe(7);
    expect(pitch.querySelector('output')!.textContent).toBe('+7 st');
    byText('.editor .btn', 'Reset').click();
    expect(rig.c.state.doc.tracks.tom.semitones).toBe(0);
  });

  it('selects another built-in sample', () => {
    const sel = q<HTMLSelectElement>('#sample-select');
    sel.value = 'builtin:cowbell';
    sel.dispatchEvent(new Event('change'));
    expect(rig.c.state.doc.tracks.kick.sampleId).toBe('builtin:cowbell');
    expect(q('.sample-info').textContent).toMatch(/Cowbell/);
    byText('.sample-row .btn', 'Use default').click();
    expect(rig.c.state.doc.tracks.kick.sampleId).toBe('builtin:kick-deep');
  });

  it('shows the import preview and assigns it', async () => {
    const { fakeAudioBytes, fakeFile } = await import('./fakes');
    await rig.c.importSampleFile('kick', fakeFile(fakeAudioBytes(0.5), 'big kick.wav'));
    const box = q('.pending');
    expect(box.hidden).toBe(false);
    expect(box.textContent).toMatch(/big kick\.wav/);
    expect(box.textContent).toMatch(/500 ms/);
    byText('.pending .btn', 'Assign to Kick').click();
    await flush();
    expect(q('.pending').hidden).toBe(true);
    expect(rig.c.state.doc.tracks.kick.sampleId).toMatch(/^user:/);
    expect(q('#sample-select').textContent).toMatch(/big kick\.wav/);
  });
});
