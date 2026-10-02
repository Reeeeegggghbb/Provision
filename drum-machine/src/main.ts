import './styles.css';
import { AudioEngine } from './audio/engine';
import { Controller } from './controller';
import { createTicker } from './sequencer/ticker';
import { openStorage } from './storage/storage';
import { mountApp } from './ui/app';

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) {
    root.innerHTML = '<p class="fatal">This browser does not support the Web Audio API, which the drum machine needs.</p>';
    return;
  }
  const engine = new AudioEngine(() => new AC({ latencyHint: 'interactive' }));
  const storage = await openStorage();
  const controller = new Controller({ engine, storage, ticker: createTicker() });
  mountApp(root, controller);
  await controller.init();

  // Flush the autosave when the page is hidden or closed.
  window.addEventListener('pagehide', () => void controller.saveSession());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void controller.saveSession();
  });

  // Test/diagnostic hook (read-only use in browser integration tests).
  (window as unknown as { __drumMachine?: Controller }).__drumMachine = controller;
}

void boot();
