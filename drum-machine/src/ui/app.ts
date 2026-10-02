import type { Controller, State } from '../controller';
import { SECTION_COUNT } from '../model/types';
import { h, icon, isInteractiveTarget, isTypingTarget, setText, toggleClass } from './dom';
import { EditorView } from './editor';
import { GridView, SectionBar } from './grid';
import { LibraryView } from './library';
import { MixerView } from './mixer';
import { Toasts } from './toast';
import { TransportView } from './transport';

export interface MountedApp {
  root: HTMLElement;
  grid: GridView;
  transport: TransportView;
  library: LibraryView;
  frame(): void;
  destroy(): void;
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['Esc', 'Stop'],
  ['Home', 'Return to start'],
  ['1 – 4', 'Select section A – D'],
  ['← → ↑ ↓', 'Move between steps'],
  ['Enter / Space', 'Toggle focused step'],
  ['A or Shift-click', 'Accent step'],
  ['Ctrl/⌘ + S', 'Save pattern'],
];

export function mountApp(root: HTMLElement, c: Controller, opts: { raf?: boolean } = {}): MountedApp {
  const transport = new TransportView(c);
  const sections = new SectionBar(c);
  const grid = new GridView(c);
  const mixer = new MixerView(c);
  const editor = new EditorView(c);
  const library = new LibraryView(c);
  const toasts = new Toasts();
  c.onToast((m, k) => toasts.show(m, k));

  const nameInput = h('input', {
    type: 'text',
    id: 'pattern-name',
    class: 'pattern-name-input',
    maxlength: 80,
    'aria-label': 'Pattern name',
    title: 'Pattern name (click to rename)',
  });
  const commitName = () => {
    const v = nameInput.value.trim();
    if (v) void c.renameCurrent(v);
    else nameInput.value = c.state.doc.name;
  };
  nameInput.addEventListener('change', commitName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
    if (e.key === 'Escape') {
      nameInput.value = c.state.doc.name;
      nameInput.blur();
    }
  });
  const dirtyDot = h('span', { class: 'dirty', title: 'Unsaved changes' });
  const saveLabel = h('span', null, 'Save');
  const saveBtn = h('button', { type: 'button', class: 'btn primary', title: 'Save pattern (Ctrl/⌘ + S)', onClick: () => void c.save() }, icon('save'), saveLabel);
  const libBtn = h(
    'button',
    { type: 'button', class: 'btn', 'aria-controls': 'library', 'aria-expanded': 'false', onClick: () => setLibrary(library.el.hidden !== false) },
    icon('folder'),
    'Patterns',
  );
  const helpPanel = h(
    'div',
    { class: 'help', id: 'shortcuts', hidden: true, role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
    h('h2', null, 'Keyboard shortcuts'),
    h('dl', null, SHORTCUTS.flatMap(([k, d]) => [h('dt', null, h('kbd', null, k)), h('dd', null, d)])),
  );
  const helpBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn help-btn',
      'aria-label': 'Keyboard shortcuts',
      'aria-controls': 'shortcuts',
      'aria-expanded': 'false',
      onClick: () => {
        helpPanel.hidden = !helpPanel.hidden;
        helpBtn.setAttribute('aria-expanded', String(!helpPanel.hidden));
      },
    },
    '?',
  );

  function setLibrary(open: boolean): void {
    library.el.hidden = !open;
    libBtn.setAttribute('aria-expanded', String(open));
    toggleClass(root, 'library-open', open);
    if (open) library.el.querySelector<HTMLElement>('button, input')?.focus();
    else libBtn.focus();
  }
  library.onClose = () => setLibrary(false);

  const header = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }), h('h1', null, 'Drum Machine')),
    h('div', { class: 'pattern-title' }, nameInput, dirtyDot),
    h('div', { class: 'top-actions' }, saveBtn, libBtn, helpBtn),
    helpPanel,
  );

  const main = h(
    'main',
    { class: 'main' },
    transport.el,
    h('div', { class: 'sequencer' }, sections.el, grid.el),
    h('div', { class: 'lower' }, mixer.el, editor.el),
  );

  root.replaceChildren(header, h('div', { class: 'layout' }, main, library.el), toasts.el);

  const update = (s: State) => {
    if (document.activeElement !== nameInput && nameInput.value !== s.doc.name) nameInput.value = s.doc.name;
    toggleClass(dirtyDot, 'on', s.dirty);
    dirtyDot.setAttribute('aria-label', s.dirty ? 'Unsaved changes' : 'Saved');
    setText(saveLabel, s.currentPatternId ? 'Save' : 'Save…');
    transport.update(s);
    sections.update(s);
    grid.update(s);
    mixer.update(s);
    editor.update(s);
    library.update(s);
  };
  const unsubscribe = c.subscribe(update);
  update(c.state);

  // ---- keyboard shortcuts
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void c.save();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
    if (e.key === ' ' && !isInteractiveTarget(e.target)) {
      e.preventDefault();
      void c.togglePlay();
    } else if (e.key === 'Escape') {
      if (!helpPanel.hidden) {
        helpPanel.hidden = true;
        helpBtn.setAttribute('aria-expanded', 'false');
      } else if (!library.el.hidden) setLibrary(false);
      else c.stop();
    } else if (e.key === 'Home' && !(e.target instanceof HTMLElement && e.target.closest('.steps, input[type="range"]'))) {
      e.preventDefault();
      c.rewind();
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= SECTION_COUNT && !(e.target instanceof HTMLInputElement)) {
      c.selectSection(Number(e.key) - 1);
    }
  };
  document.addEventListener('keydown', onKey);

  // Dropping a file outside a drop zone must not navigate away from the app.
  const preventNav = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  };
  window.addEventListener('dragover', preventNav);
  window.addEventListener('drop', preventNav);

  const onVisibility = () => c.setHidden(document.visibilityState === 'hidden');
  document.addEventListener('visibilitychange', onVisibility);

  // ---- playhead animation, driven by the audio clock
  const frame = () => {
    const ph = c.playhead();
    if (ph && ph.section === c.state.doc.activeSection) {
      grid.setPlaying(ph.step);
      transport.showPosition(ph.step);
    } else if (c.state.transport !== 'playing') {
      grid.setPlaying(-1);
    }
  };
  let rafId = 0;
  const loop = () => {
    frame();
    rafId = requestAnimationFrame(loop);
  };
  if (opts.raf !== false && typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(loop);

  return {
    root,
    grid,
    transport,
    library,
    frame,
    destroy() {
      cancelAnimationFrame(rafId);
      unsubscribe();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('dragover', preventNav);
      window.removeEventListener('drop', preventNav);
    },
  };
}
