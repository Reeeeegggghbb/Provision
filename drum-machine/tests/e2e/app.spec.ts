import { expect, test, type Page } from '@playwright/test';
import { makeWav } from './helpers';

/*
 * Browser integration tests: real Chromium, real AudioContext, real IndexedDB and real audio
 * decoding. They verify that events are scheduled against the AudioContext clock correctly
 * and that the UI works end to end. They do NOT listen to the audio output; audible timing
 * still needs a manual check (see README).
 */

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const c = (window as unknown as { __drumMachine?: { state: { savedPatterns: unknown[] } } }).__drumMachine;
    return !!c && c.state.savedPatterns.length > 0;
  });
}

const step = (page: Page, track: string, i: number) => page.locator(`.grid-row[data-track="${track}"] .step[data-step="${i}"]`);

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  (page as unknown as { __errors: string[] }).__errors = errors;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { __errors: string[] }).__errors).toEqual([]);
});

test('loads with example patterns and the default kit', async ({ page }) => {
  await ready(page);
  await expect(page.locator('#pattern-name')).toHaveValue('Boom Bap');
  await expect(page.locator('.grid-body .grid-row')).toHaveCount(7);
  await expect(page.locator('.grid-row[data-track="kick"] .step')).toHaveCount(16);
  await expect(page.locator('.audio-pill')).toHaveText('Audio starts on Play');
});

test('plays with a running AudioContext and a moving, synchronised playhead', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('.audio-pill')).toHaveText('Audio on');
  await expect(page.locator('.step.playing').first()).toBeVisible();

  // Sample the playhead several times: the highlighted step must be the step the audio
  // scheduler says is audible at the current AudioContext time.
  for (let i = 0; i < 8; i++) {
    const r = await page.evaluate(() => {
      type C = { engine: { currentTime: number; outputLatency: number }; sequencer: { eventAt(t: number): { step: number } | null } };
      const c = (window as unknown as { __drumMachine: C }).__drumMachine;
      const ev = c.sequencer.eventAt(c.engine.currentTime - c.engine.outputLatency);
      const el = document.querySelector('.grid-row[data-track="kick"] .step.playing') as HTMLElement | null;
      return { audible: ev?.step ?? -1, shown: el ? Number(el.dataset.step) : -1 };
    });
    // The DOM updates on the next animation frame, so allow it to trail by one step.
    expect([r.audible, (r.audible + 15) % 16]).toContain(r.shown);
    await page.waitForTimeout(170);
  }

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('.step.playing')).toHaveCount(0);
});

test('schedules hits ahead of time on the real audio clock, exactly one step apart', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Patterns' }).click();
  await page.getByRole('button', { name: 'New blank' }).click();
  await page.locator('#bpm-input').fill('150');
  await page.locator('#bpm-input').press('Enter');
  // A closed hat on every step
  for (let i = 0; i < 16; i++) await step(page, 'closedHat', i).click();

  await page.evaluate(() => {
    type E = { trigger: (...a: unknown[]) => unknown; currentTime: number };
    const c = (window as unknown as { __drumMachine: { engine: E } }).__drumMachine;
    const log: { time: number; at: number }[] = [];
    (window as unknown as { __log: typeof log }).__log = log;
    const orig = c.engine.trigger.bind(c.engine);
    c.engine.trigger = (...args: unknown[]) => {
      log.push({ time: args[2] as number, at: c.engine.currentTime });
      return orig(...args);
    };
  });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(2500);
  // Change tempo mid-playback.
  await page.locator('#bpm-input').fill('100');
  await page.locator('#bpm-input').press('Enter');
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'Pause' }).click();

  const log = await page.evaluate(() => (window as unknown as { __log: { time: number; at: number }[] }).__log);
  expect(log.length).toBeGreaterThan(30);
  // Every hit was scheduled before its playback time (lookahead), never in the past.
  for (const e of log) expect(e.time).toBeGreaterThan(e.at);
  const gaps = log.slice(1).map((e, i) => e.time - log[i].time);
  const fast = 60 / 150 / 4;
  const slow = 60 / 100 / 4;
  // Gaps are exactly one step at either tempo (no jitter from JS timers), with one
  // transition gap of the old step length at the tempo change.
  for (const g of gaps) {
    const ok = Math.abs(g - fast) < 1e-6 || Math.abs(g - slow) < 1e-6;
    expect(ok, `gap ${g}`).toBe(true);
  }
  expect(gaps.filter((g) => Math.abs(g - slow) < 1e-6).length).toBeGreaterThan(5);
});

test('step edits, mute and tempo persist across a page refresh', async ({ page }) => {
  await ready(page);
  await step(page, 'tom', 6).click();
  await page.locator('.grid-row[data-track="clap"] .ms.mute').click();
  await page.locator('#bpm-input').fill('97');
  await page.locator('#bpm-input').press('Enter');
  await page.waitForTimeout(600); // autosave debounce
  await page.reload();
  await ready(page);
  await expect(step(page, 'tom', 6)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.grid-row[data-track="clap"] .ms.mute')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#bpm-input')).toHaveValue('97');
});

test('keyboard: navigate the grid, toggle steps, play/pause with Space', async ({ page }) => {
  await ready(page);
  await step(page, 'kick', 0).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(step(page, 'snare', 1)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('a');
  await expect(step(page, 'snare', 1)).toHaveClass(/accent/);
  await expect(step(page, 'snare', 1)).toBeFocused();
  // Space on a focused step toggles it (native button behaviour)…
  await page.keyboard.press('Space');
  await expect(step(page, 'snare', 1)).toHaveAttribute('aria-pressed', 'false');
  // …and plays/pauses when focus is not on a control.
  await page.locator('.hint').click();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Pause' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
});

test('saves, renames and deletes patterns in the library', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Patterns' }).click();
  await page.locator('#save-as-name').fill('E2E Groove');
  await page.getByRole('button', { name: 'Save as' }).click();
  await expect(page.getByRole('button', { name: 'Load E2E Groove' })).toBeVisible();
  await page.reload();
  await ready(page);
  await page.getByRole('button', { name: 'Patterns' }).click();
  await page.getByRole('button', { name: 'Rename E2E Groove' }).click();
  await page.getByLabel('New name for E2E Groove').fill('E2E Renamed');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Load E2E Renamed' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete E2E Renamed' }).click();
  await page.getByRole('button', { name: 'Confirm delete E2E Renamed' }).click();
  await expect(page.getByRole('button', { name: 'Load E2E Renamed' })).toHaveCount(0);
});

test('imports a real WAV file, previews, assigns, and keeps it after reload', async ({ page }) => {
  await ready(page);
  await page.locator('#sample-file').setInputFiles({ name: 'test-tom.wav', mimeType: 'audio/wav', buffer: makeWav(0.3) });
  const pending = page.locator('.pending');
  await expect(pending).toBeVisible();
  await expect(pending).toContainText('test-tom.wav');
  await expect(pending).toContainText('300 ms');
  await pending.getByRole('button', { name: 'Preview' }).click();
  await pending.getByRole('button', { name: 'Assign to Kick' }).click();
  await expect(pending).toBeHidden();
  await expect(page.locator('.sample-info')).toContainText('test-tom.wav');
  await page.getByRole('button', { name: 'Audition' }).click();

  await page.waitForTimeout(600);
  await page.reload();
  await ready(page);
  await expect(page.locator('.sample-info')).toContainText('test-tom.wav');
  const dur = await page.evaluate(() => {
    type C = { state: { doc: { tracks: { kick: { sampleId: string } } } }; engine: { getBuffer(id: string): AudioBuffer | undefined } };
    const c = (window as unknown as { __drumMachine: C }).__drumMachine;
    return c.engine.getBuffer(c.state.doc.tracks.kick.sampleId)?.duration ?? 0;
  });
  expect(dur).toBeGreaterThan(0.29);
  expect(dur).toBeLessThan(0.31);
});

test('rejects invalid audio files with a clear message', async ({ page }) => {
  await ready(page);
  await page.locator('#sample-file').setInputFiles({ name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.from('this is not really audio data') });
  await expect(page.locator('.toast.error')).toContainText('could not decode');
  await page.locator('#sample-file').setInputFiles({ name: 'empty.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(0) });
  await expect(page.locator('.toast.error').last()).toContainText('empty');
  await expect(page.locator('.pending')).toBeHidden();
});

test('exports and re-imports a pattern as JSON', async ({ page }) => {
  await ready(page);
  await step(page, 'rim', 9).click();
  await page.getByRole('button', { name: 'Patterns' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export JSON' }).click()]);
  const path = await download.path();
  const fs = await import('node:fs');
  const json = fs.readFileSync(path!, 'utf8');
  expect(JSON.parse(json).format).toBe('drum-machine-pattern');

  await page.getByRole('button', { name: 'New blank' }).click();
  await expect(step(page, 'rim', 9)).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#import-json').setInputFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await expect(step(page, 'rim', 9)).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#import-json').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(page.locator('.toast.error')).toContainText('not valid JSON');
});
