import { AudioEngine } from '../../src/audio/engine';
import { Controller, type ToastKind } from '../../src/controller';
import { MemoryStorage, type StorageBackend } from '../../src/storage/storage';
import { FakeAudioContext, ManualTicker, type FakeContextOptions } from './fakes';

export interface Rig {
  c: Controller;
  storage: StorageBackend;
  ticker: ManualTicker;
  ctx: () => FakeAudioContext;
  toasts: [string, ToastKind][];
}

export async function makeRig(
  opts: { storage?: StorageBackend; audio?: FakeContextOptions; init?: boolean } = {},
): Promise<Rig> {
  const storage = opts.storage ?? new MemoryStorage();
  let ctx: FakeAudioContext | null = null;
  const engine = new AudioEngine(() => (ctx = new FakeAudioContext(opts.audio)).asReal());
  const ticker = new ManualTicker();
  const c = new Controller({ engine, storage, ticker, autosaveDelayMs: 0, now: () => 1_700_000_000_000 });
  const toasts: [string, ToastKind][] = [];
  c.onToast((m, k) => toasts.push([m, k]));
  if (opts.init !== false) await c.init();
  return {
    c,
    storage,
    ticker,
    toasts,
    ctx: () => {
      if (!ctx) engine.ensureContext();
      return ctx!;
    },
  };
}

/** Let pending promises and zero-delay timers (autosave) run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}
