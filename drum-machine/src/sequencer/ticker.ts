/** A periodic wake-up source for the scheduler. `start` must be idempotent. */
export interface Ticker {
  start(callback: () => void, intervalMs: number): void;
  stop(): void;
  readonly running: boolean;
}

/** Main-thread timer. Used as a fallback when Workers are unavailable. */
export class IntervalTicker implements Ticker {
  private id: ReturnType<typeof setInterval> | null = null;

  get running(): boolean {
    return this.id !== null;
  }

  start(callback: () => void, intervalMs: number): void {
    this.stop();
    this.id = setInterval(callback, intervalMs);
  }

  stop(): void {
    if (this.id !== null) clearInterval(this.id);
    this.id = null;
  }
}

const WORKER_SOURCE = `
let id = null;
self.onmessage = (e) => {
  if (id !== null) { clearInterval(id); id = null; }
  if (e.data && e.data.cmd === 'start') id = setInterval(() => self.postMessage(0), e.data.interval);
};
`;

/**
 * Timer running inside a dedicated Worker. Browsers throttle main-thread timers heavily in
 * background tabs; worker timers are throttled much less, which keeps the lookahead
 * scheduler fed. The audio itself is always scheduled on the AudioContext clock.
 */
export class WorkerTicker implements Ticker {
  private worker: Worker;
  private callback: (() => void) | null = null;
  private url: string;

  constructor() {
    this.url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    this.worker = new Worker(this.url);
    this.worker.onmessage = () => this.callback?.();
  }

  get running(): boolean {
    return this.callback !== null;
  }

  start(callback: () => void, intervalMs: number): void {
    this.callback = callback;
    this.worker.postMessage({ cmd: 'start', interval: intervalMs });
  }

  stop(): void {
    this.callback = null;
    this.worker.postMessage({ cmd: 'stop' });
  }

  dispose(): void {
    this.stop();
    this.worker.terminate();
    URL.revokeObjectURL(this.url);
  }
}

export function createTicker(): Ticker {
  try {
    if (typeof Worker !== 'undefined' && typeof URL.createObjectURL === 'function') return new WorkerTicker();
  } catch {
    // e.g. a Content-Security-Policy that forbids blob: workers
  }
  return new IntervalTicker();
}
