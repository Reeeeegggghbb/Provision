import { gridTime, stepDuration, swingOffset } from './timing';
import type { Ticker } from './ticker';

const HISTORY_SECONDS = 1;

export type TransportState = 'stopped' | 'playing' | 'paused';

export interface Clock {
  /** Current audio clock time in seconds (AudioContext.currentTime). */
  now(): number;
}

export interface StepEvent {
  generation: number;
  /** AudioContext time at which the step sounds (swing included). */
  time: number;
  section: number;
  /** Step index within the section. */
  step: number;
  /** Absolute step counter since play started from the beginning. */
  absStep: number;
  /** Step duration at the tempo the step was scheduled with. */
  duration: number;
}

export type CancelMode = 'pause' | 'stop';

export interface SequencerHost {
  clock: Clock;
  ticker: Ticker;
  sectionLength(section: number): number;
  /** Called once per step, ahead of time, so the host can schedule audio at `ev.time`. */
  onSchedule(ev: StepEvent): void;
  /** Called when pending (already scheduled, not yet audible) events must be cancelled. */
  onCancel(fromTime: number, mode: CancelMode): void;
  onStateChange?(state: TransportState): void;
}

export interface SequencerOptions {
  bpm?: number;
  swing?: number;
  /** How far ahead of the audio clock events are scheduled, in seconds. */
  lookahead?: number;
  /** How often the scheduler wakes, in milliseconds. */
  intervalMs?: number;
  /** Delay between pressing play and the first step, in seconds. */
  startDelay?: number;
  /** If the scheduler falls further behind than this, the timeline is re-anchored. */
  maxLateness?: number;
}

/**
 * Lookahead step scheduler ("two clocks" pattern). A coarse JS timer wakes every
 * `intervalMs` and schedules every step whose time falls inside `now + lookahead` against
 * the audio clock. Step times are computed from an anchor, so neither tempo changes nor
 * swing accumulate drift.
 */
export class Sequencer {
  private _state: TransportState = 'stopped';
  private generation = 0;
  private bpm: number;
  private swing: number;
  private _section = 0;
  private _queuedSection: number | null = null;
  /** Next step (within the section) to schedule. */
  private position = 0;
  /** Absolute counter of the next step to schedule. */
  private absStep = 0;
  private anchorTime = 0;
  private anchorStep = 0;
  private events: StepEvent[] = [];
  private _lookahead: number;
  readonly intervalMs: number;
  readonly startDelay: number;
  readonly maxLateness: number;
  /** Number of times the timeline was re-anchored because the scheduler woke too late. */
  resyncCount = 0;

  constructor(
    private host: SequencerHost,
    opts: SequencerOptions = {},
  ) {
    this.bpm = opts.bpm ?? 120;
    this.swing = opts.swing ?? 0.5;
    this._lookahead = opts.lookahead ?? 0.12;
    this.intervalMs = opts.intervalMs ?? 25;
    this.startDelay = opts.startDelay ?? 0.05;
    this.maxLateness = opts.maxLateness ?? 0.05;
  }

  get state(): TransportState {
    return this._state;
  }
  get section(): number {
    return this._section;
  }
  get queuedSection(): number | null {
    return this._queuedSection;
  }
  get tempo(): number {
    return this.bpm;
  }
  get lookahead(): number {
    return this._lookahead;
  }
  /** Step that will be scheduled next (when stopped/paused: where playback will resume). */
  get nextStep(): number {
    return this.position;
  }
  get currentGeneration(): number {
    return this.generation;
  }

  setLookahead(seconds: number): void {
    this._lookahead = Math.max(0.03, seconds);
  }

  private setState(s: TransportState): void {
    if (this._state === s) return;
    this._state = s;
    this.host.onStateChange?.(s);
  }

  private get stepDur(): number {
    return stepDuration(this.bpm);
  }

  /** Start or resume playback. Returns false (and does nothing) if already playing. */
  play(): boolean {
    if (this._state === 'playing') return false;
    this.generation++;
    this.events = [];
    this.anchorTime = this.host.clock.now() + this.startDelay;
    this.anchorStep = this.absStep;
    this.setState('playing');
    const gen = this.generation;
    this.host.ticker.start(() => this.tick(gen), this.intervalMs);
    this.tick(gen);
    return true;
  }

  /** Pause, keeping the position of the first step that has not been heard yet. */
  pause(): boolean {
    if (this._state !== 'playing') return false;
    const now = this.host.clock.now();
    const firstPending = this.events.find((e) => e.time > now);
    if (firstPending) {
      if (firstPending.section !== this._section) {
        // The section switch has not been heard yet: keep it queued.
        this._queuedSection = this._section;
        this._section = firstPending.section;
      }
      this.position = firstPending.step;
      this.absStep = firstPending.absStep;
    }
    this.halt();
    this.host.onCancel(now, 'pause');
    this.setState('paused');
    return true;
  }

  /** Stop and return to the start of the current section. */
  stop(): void {
    const wasActive = this._state !== 'stopped';
    this.halt();
    this.host.onCancel(this.host.clock.now(), 'stop');
    if (this._queuedSection !== null) {
      this._section = this._queuedSection;
      this._queuedSection = null;
    }
    this.position = 0;
    this.absStep = 0;
    if (wasActive) this.setState('stopped');
  }

  /** Jump to step 0. While playing, playback continues seamlessly from the start. */
  rewind(): void {
    if (this._state !== 'playing') {
      this.position = 0;
      this.absStep = 0;
      return;
    }
    const now = this.host.clock.now();
    this.generation++;
    this.host.onCancel(now, 'pause');
    this.events = [];
    this.position = 0;
    this.anchorTime = now + this.startDelay;
    this.anchorStep = this.absStep;
    const gen = this.generation;
    this.host.ticker.stop();
    this.host.ticker.start(() => this.tick(gen), this.intervalMs);
    this.tick(gen);
  }

  private halt(): void {
    this.generation++;
    this.host.ticker.stop();
    this.events = [];
  }

  setTempo(bpm: number): void {
    if (bpm === this.bpm) return;
    if (this._state === 'playing') {
      // Re-anchor at the next unscheduled step using the old tempo, so the transition is
      // continuous. Steps already scheduled keep their times.
      this.anchorTime = gridTime(this.anchorTime, this.anchorStep, this.absStep, this.stepDur);
      this.anchorStep = this.absStep;
    }
    this.bpm = bpm;
  }

  setSwing(swing: number): void {
    this.swing = swing;
  }

  /** Select a section. While playing the change is queued until the current section ends. */
  selectSection(index: number): void {
    if (this._state === 'playing') {
      this._queuedSection = index === this._section ? null : index;
      return;
    }
    this._section = index;
    this._queuedSection = null;
    this.position = 0;
  }

  /** Scheduler pass. Public for deterministic tests; normally driven by the ticker. */
  tick(gen = this.generation): void {
    if (this._state !== 'playing' || gen !== this.generation) return;
    const now = this.host.clock.now();
    const horizon = now + this._lookahead;
    const dur = this.stepDur;

    // If the timer was starved (e.g. throttled tab), don't fire a burst of late notes:
    // shift the timeline so the next step starts now.
    if (gridTime(this.anchorTime, this.anchorStep, this.absStep, dur) < now - this.maxLateness) {
      this.anchorTime = now + 0.01;
      this.anchorStep = this.absStep;
      this.resyncCount++;
    }

    let guard = 0;
    for (;;) {
      if (this.position >= this.host.sectionLength(this._section)) {
        this.position = 0;
        if (this._queuedSection !== null) {
          this._section = this._queuedSection;
          this._queuedSection = null;
        }
      }
      const time = gridTime(this.anchorTime, this.anchorStep, this.absStep, dur) + swingOffset(this.position, dur, this.swing);
      if (time >= horizon || guard++ > 1024) break;
      const ev: StepEvent = {
        generation: this.generation,
        time,
        section: this._section,
        step: this.position,
        absStep: this.absStep,
        duration: dur,
      };
      this.events.push(ev);
      this.host.onSchedule(ev);
      // The host callback may have stopped the transport.
      if (gen !== this.generation) return;
      this.position++;
      this.absStep++;
    }

    // Keep the event list short. Retain ~1 s of history because the playhead is drawn at
    // `now - outputLatency`, which lags the scheduler's notion of "now".
    const keepFrom = now - HISTORY_SECONDS;
    let lastPast = -1;
    for (let i = 0; i < this.events.length; i++) if (this.events[i].time <= keepFrom) lastPast = i;
    if (lastPast > 0) this.events.splice(0, lastPast);
  }

  /** The step that is audible at `audioTime` (for drawing the playhead), or null. */
  eventAt(audioTime: number): StepEvent | null {
    let found: StepEvent | null = null;
    for (const e of this.events) {
      if (e.time <= audioTime) found = e;
      else break;
    }
    return found;
  }

  /** Scheduled events not yet trimmed (for diagnostics/tests). */
  get scheduledEvents(): readonly StepEvent[] {
    return this.events;
  }

  dispose(): void {
    this.halt();
    this._state = 'stopped';
  }
}
