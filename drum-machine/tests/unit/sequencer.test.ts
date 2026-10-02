import { beforeEach, describe, expect, it } from 'vitest';
import { Sequencer, type CancelMode, type StepEvent, type TransportState } from '../../src/sequencer/sequencer';
import { stepDuration } from '../../src/sequencer/timing';
import { ManualTicker } from './fakes';

class Harness {
  now = 0;
  ticker = new ManualTicker();
  events: StepEvent[] = [];
  cancels: [number, CancelMode][] = [];
  states: TransportState[] = [];
  lengths = [16, 16, 16, 16];
  seq: Sequencer;

  constructor(opts: ConstructorParameters<typeof Sequencer>[1] = {}) {
    this.seq = new Sequencer(
      {
        clock: { now: () => this.now },
        ticker: this.ticker,
        sectionLength: (i) => this.lengths[i],
        onSchedule: (ev) => this.events.push(ev),
        onCancel: (t, m) => this.cancels.push([t, m]),
        onStateChange: (s) => this.states.push(s),
      },
      { lookahead: 0.1, startDelay: 0.05, ...opts },
    );
  }

  /** Advance the fake audio clock in timer-sized increments, firing the ticker each time. */
  advance(seconds: number, interval = 0.025) {
    const end = this.now + seconds;
    while (this.now < end - 1e-12) {
      this.now = Math.min(end, this.now + interval);
      this.ticker.fire();
    }
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

describe('scheduling', () => {
  it('schedules steps against the audio clock with lookahead', () => {
    h.now = 1;
    h.seq.play();
    // First step at now + startDelay; only steps inside the lookahead window are scheduled.
    expect(h.events[0].time).toBeCloseTo(1.05, 12);
    expect(h.events.every((e) => e.time < 1 + 0.1)).toBe(true);
    h.advance(1);
    const dur = stepDuration(120);
    h.events.forEach((e, i) => {
      expect(e.absStep).toBe(i);
      expect(e.time).toBeCloseTo(1.05 + i * dur, 12);
      expect(e.time).toBeLessThan(h.now + 0.1 + 1e-9);
    });
    // Every scheduled event was scheduled ahead of its playback time.
    expect(h.events.length).toBeGreaterThan(7);
  });

  it.each([40, 90, 120, 177, 240])('places steps exactly at %d BPM', (bpm) => {
    h.seq.setTempo(bpm);
    h.seq.play();
    h.advance(4);
    const dur = 60 / bpm / 4;
    h.events.forEach((e, i) => expect(e.time).toBeCloseTo(0.05 + i * dur, 9));
    // Bar boundaries fall every 16 steps = 4 beats.
    const bar2 = h.events.find((e) => e.absStep === 16);
    if (bar2) expect(bar2.time - h.events[0].time).toBeCloseTo((60 / bpm) * 4, 9);
  });

  it('loops the section and reports step indices within it', () => {
    h.lengths[0] = 8;
    h.seq.play();
    h.advance(2.5);
    const steps = h.events.map((e) => e.step);
    expect(steps.slice(0, 18)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7, 0, 1]);
  });

  it('supports 32-step sections', () => {
    h.lengths[0] = 32;
    h.seq.play();
    h.advance(5);
    expect(Math.max(...h.events.map((e) => e.step))).toBe(31);
    expect(h.events[32].step).toBe(0);
  });

  it('applies swing to odd steps only, without drift over many bars', () => {
    h.seq.setSwing(0.62);
    h.seq.play();
    h.advance(60);
    const dur = stepDuration(120);
    for (const e of h.events) {
      const expected = 0.05 + e.absStep * dur + (e.step % 2 ? 0.24 * dur : 0);
      expect(e.time).toBeCloseTo(expected, 9);
    }
    expect(h.events.length).toBeGreaterThan(400);
  });

  it('re-anchors instead of bursting late notes when the timer is starved', () => {
    h.seq.play();
    h.advance(0.5);
    const before = h.events.length;
    h.now += 2; // e.g. a throttled background tab
    h.ticker.fire();
    const late = h.events.slice(before);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((e) => e.time >= h.now)).toBe(true);
    expect(h.seq.resyncCount).toBe(1);
  });
});

describe('tempo changes during playback', () => {
  it('keeps already scheduled steps and continues seamlessly at the new tempo', () => {
    h.seq.play();
    h.advance(1);
    const scheduled = h.events.length;
    const last = h.events[scheduled - 1];
    h.seq.setTempo(60);
    h.advance(2);
    const next = h.events[scheduled];
    // The first step after the change lands one OLD step after the last scheduled one…
    expect(next.time - last.time).toBeCloseTo(stepDuration(120), 9);
    // …and subsequent steps use the new duration.
    for (let i = scheduled + 1; i < h.events.length; i++) {
      expect(h.events[i].time - h.events[i - 1].time).toBeCloseTo(stepDuration(60), 9);
    }
  });

  it('accepts many tempo changes without breaking monotonic step order', () => {
    h.seq.play();
    for (let i = 0; i < 50; i++) {
      h.seq.setTempo(40 + ((i * 37) % 200));
      h.advance(0.1);
    }
    for (let i = 1; i < h.events.length; i++) {
      expect(h.events[i].time).toBeGreaterThan(h.events[i - 1].time);
      expect(h.events[i].absStep).toBe(h.events[i - 1].absStep + 1);
    }
  });
});

describe('transport', () => {
  it('ignores repeated play: one ticker loop, no duplicate steps', () => {
    expect(h.seq.play()).toBe(true);
    expect(h.seq.play()).toBe(false);
    expect(h.seq.play()).toBe(false);
    expect(h.ticker.starts).toBe(1);
    h.advance(1);
    const abs = h.events.map((e) => e.absStep);
    expect(new Set(abs).size).toBe(abs.length);
  });

  it('pause cancels pending events and resumes from the first unheard step', () => {
    h.seq.play();
    h.advance(0.5);
    const pending = h.events.filter((e) => e.time > h.now);
    expect(pending.length).toBeGreaterThan(0);
    expect(h.seq.pause()).toBe(true);
    expect(h.cancels.at(-1)).toEqual([h.now, 'pause']);
    expect(h.seq.state).toBe('paused');
    expect(h.ticker.running).toBe(false);
    expect(h.seq.nextStep).toBe(pending[0].step);

    const count = h.events.length;
    h.advance(1); // nothing scheduled while paused
    expect(h.events.length).toBe(count);

    h.seq.play();
    const resumed = h.events[count];
    expect(resumed.step).toBe(pending[0].step);
    expect(resumed.time).toBeCloseTo(h.now + 0.05, 9);
  });

  it('pause/stop when not playing are harmless', () => {
    expect(h.seq.pause()).toBe(false);
    h.seq.stop();
    h.seq.stop();
    expect(h.seq.state).toBe('stopped');
    expect(h.states).toEqual([]);
  });

  it('stop invalidates in-flight timer callbacks and resets to the start', () => {
    h.seq.play();
    h.advance(0.6);
    const staleCallback = h.ticker.callback!;
    h.seq.stop();
    expect(h.cancels.at(-1)![1]).toBe('stop');
    const count = h.events.length;
    h.now += 0.5;
    staleCallback(); // a late message from the old loop
    expect(h.events.length).toBe(count);
    expect(h.seq.nextStep).toBe(0);
    h.seq.play();
    expect(h.events[count].step).toBe(0);
    expect(h.events[count].absStep).toBe(0);
  });

  it('survives rapid play/pause/stop sequences with a single active loop', () => {
    for (let i = 0; i < 20; i++) {
      h.seq.play();
      h.advance(0.05);
      if (i % 3 === 0) h.seq.pause();
      else if (i % 3 === 1) h.seq.stop();
      h.seq.play();
      h.seq.play();
    }
    expect(h.seq.state).toBe('playing');
    expect(h.ticker.starts - h.ticker.stops).toBe(1);
    const gen = h.seq.currentGeneration;
    const before = h.events.length;
    h.advance(0.5);
    expect(h.events.slice(before).every((e) => e.generation === gen)).toBe(true);
  });

  it('rewind while playing restarts from step 0 immediately', () => {
    h.seq.play();
    h.advance(0.7);
    const count = h.events.length;
    h.seq.rewind();
    expect(h.seq.state).toBe('playing');
    expect(h.cancels.at(-1)![1]).toBe('pause');
    expect(h.events[count].step).toBe(0);
    expect(h.events[count].time).toBeCloseTo(h.now + 0.05, 9);
    expect(h.ticker.starts - h.ticker.stops).toBe(1);
  });

  it('rewind while paused moves the resume point to 0', () => {
    h.seq.play();
    h.advance(0.7);
    h.seq.pause();
    h.seq.rewind();
    expect(h.seq.nextStep).toBe(0);
  });

  it('reports state changes', () => {
    h.seq.play();
    h.seq.pause();
    h.seq.play();
    h.seq.stop();
    expect(h.states).toEqual(['playing', 'paused', 'playing', 'stopped']);
  });
});

describe('sections', () => {
  it('switches immediately when stopped', () => {
    h.seq.selectSection(2);
    expect(h.seq.section).toBe(2);
    expect(h.seq.queuedSection).toBeNull();
  });

  it('queues a switch while playing and applies it at the section boundary', () => {
    h.seq.play();
    h.advance(0.5);
    h.seq.selectSection(1);
    expect(h.seq.queuedSection).toBe(1);
    h.advance(3);
    const firstB = h.events.findIndex((e) => e.section === 1);
    expect(firstB).toBeGreaterThan(0);
    expect(h.events[firstB].step).toBe(0);
    expect(h.events[firstB - 1].step).toBe(15);
    expect(h.events[firstB].absStep).toBe(16);
    expect(h.seq.queuedSection).toBeNull();
  });

  it('re-selecting the playing section clears the queue', () => {
    h.seq.play();
    h.seq.selectSection(3);
    h.seq.selectSection(0);
    expect(h.seq.queuedSection).toBeNull();
  });

  it('handles different section lengths across the switch', () => {
    h.lengths = [8, 32, 16, 16];
    h.seq.play();
    h.seq.selectSection(1);
    h.advance(6);
    const sec1 = h.events.filter((e) => e.section === 1).map((e) => e.step);
    expect(sec1.slice(0, 33)).toEqual([...Array.from({ length: 32 }, (_, i) => i), 0]);
  });

  it('wraps safely when the section is shortened during playback', () => {
    h.lengths[0] = 32;
    h.seq.play();
    h.advance(2.5); // well past step 16
    h.lengths[0] = 8;
    h.advance(1);
    const last = h.events.slice(-6);
    expect(last.every((e) => e.step < 8)).toBe(true);
  });

  it('pause keeps an unheard section switch queued', () => {
    h = new Harness({ lookahead: 0.5 });
    h.seq.play();
    h.seq.selectSection(1);
    // Advance until the scheduler has crossed into section 1 while section 0 steps are still pending.
    while (!h.events.some((e) => e.section === 1)) h.advance(0.025);
    expect(h.events.some((e) => e.section === 0 && e.time > h.now)).toBe(true);
    h.seq.pause();
    expect(h.seq.section).toBe(0);
    expect(h.seq.queuedSection).toBe(1);
  });

  it('pause right after the switch became audible resumes in the new section', () => {
    h.seq.play();
    h.seq.selectSection(1);
    while (!h.events.some((e) => e.section === 1 && e.time <= h.now)) h.advance(0.025);
    h.seq.pause();
    expect(h.seq.section).toBe(1);
    expect(h.seq.queuedSection).toBeNull();
  });
});

describe('visual sync', () => {
  it('eventAt returns the step audible at a given time', () => {
    h.seq.play();
    const dur = stepDuration(120);
    expect(h.seq.eventAt(0.01)).toBeNull();
    expect(h.seq.eventAt(0.05)!.step).toBe(0);
    h.advance(0.05 + dur * 1.5);
    expect(h.seq.eventAt(h.now)!.step).toBe(1);
    h.advance(dur);
    expect(h.seq.eventAt(h.now)!.step).toBe(2);
    // Scheduled-but-future steps are not reported early.
    expect(h.seq.eventAt(h.now)!.time).toBeLessThanOrEqual(h.now);
  });

  it('keeps the event list bounded during long playback', () => {
    h.seq.play();
    h.advance(120);
    expect(h.seq.scheduledEvents.length).toBeLessThan(16);
  });
});

describe('visual sync with output latency', () => {
  it('still finds the audible step when looking up slightly in the past', () => {
    h.seq.play();
    for (let i = 0; i < 200; i++) {
      h.advance(0.025);
      // e.g. 40 ms of output latency
      const t = h.now - 0.04;
      if (t >= 0.05) expect(h.seq.eventAt(t)).not.toBeNull();
    }
  });
});
