import type { Controller, State } from '../controller';
import { SECTION_COUNT, SECTION_LENGTHS, SECTION_NAMES, TRACK_IDS, TRACK_LABELS, type TrackId } from '../model/types';
import { isBarStart, isBeatStart, stepPosition } from '../sequencer/timing';
import { h, toggleClass } from './dom';

export class SectionBar {
  readonly el: HTMLElement;
  private buttons: HTMLButtonElement[];
  private lengthSelect: HTMLSelectElement;
  private copySelect: HTMLSelectElement;

  constructor(c: Controller) {
    this.buttons = SECTION_NAMES.map((name, i) =>
      h(
        'button',
        {
          type: 'button',
          class: 'section-btn',
          title: `Section ${name} (key ${i + 1}). While playing, the switch happens at the end of the current section.`,
          onClick: () => c.selectSection(i),
        },
        name,
      ),
    );
    this.lengthSelect = h(
      'select',
      { id: 'section-length', class: 'select', onChange: () => c.setSectionLength(Number(this.lengthSelect.value)) },
      SECTION_LENGTHS.map((n) => h('option', { value: n }, `${n} steps${n % 16 === 0 ? ` · ${n / 16} bar${n > 16 ? 's' : ''}` : ''}`)),
    );
    this.copySelect = h('select', {
      id: 'section-copy',
      class: 'select',
      'aria-label': 'Copy this section to',
      onChange: () => {
        const v = Number(this.copySelect.value);
        if (v >= 0) c.copySectionTo(v);
        this.copySelect.value = '-1';
      },
    });
    this.el = h(
      'div',
      { class: 'section-bar' },
      h('div', { class: 'section-group', role: 'group', 'aria-label': 'Sections' }, h('span', { class: 'group-label' }, 'Section'), this.buttons),
      h('div', { class: 'section-tools' },
        h('label', { for: 'section-length', class: 'group-label' }, 'Length'),
        this.lengthSelect,
        this.copySelect,
        h('button', { type: 'button', class: 'btn subtle', title: 'Clear all steps in this section', onClick: () => c.clearSection() }, 'Clear'),
      ),
    );
  }

  update(s: State): void {
    const active = s.doc.activeSection;
    this.buttons.forEach((b, i) => {
      toggleClass(b, 'active', i === active);
      toggleClass(b, 'queued', i === s.queuedSection);
      const hasNotes = TRACK_IDS.some((t) => s.doc.sections[i].steps[t].some((v) => v > 0));
      toggleClass(b, 'has-notes', hasNotes);
      b.setAttribute('aria-pressed', String(i === active));
      b.setAttribute(
        'aria-label',
        `Section ${SECTION_NAMES[i]}${i === s.queuedSection ? ', queued' : ''}${hasNotes ? '' : ', empty'}`,
      );
    });
    const len = String(s.doc.sections[active].length);
    if (![...this.lengthSelect.options].some((o) => o.value === len)) {
      this.lengthSelect.append(h('option', { value: len }, `${len} steps`));
    }
    if (this.lengthSelect.value !== len) this.lengthSelect.value = len;
    // Rebuild the copy targets (excludes the active section).
    const key = `${active}`;
    if (this.copySelect.dataset.key !== key) {
      this.copySelect.dataset.key = key;
      this.copySelect.replaceChildren(
        h('option', { value: -1 }, `Copy ${SECTION_NAMES[active]} to…`),
        ...Array.from({ length: SECTION_COUNT }, (_, i) => i)
          .filter((i) => i !== active)
          .map((i) => h('option', { value: i }, `Section ${SECTION_NAMES[i]}`)),
      );
      this.copySelect.value = '-1';
    }
  }
}

interface Row {
  track: TrackId;
  el: HTMLElement;
  nameBtn: HTMLButtonElement;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
  led: HTMLElement;
  steps: HTMLButtonElement[];
}

export class GridView {
  readonly el: HTMLElement;
  private header: HTMLElement;
  private headerCells: HTMLElement[] = [];
  private rows: Row[] = [];
  private body: HTMLElement;
  private length = 0;
  private focusTrack = 0;
  private focusStep = 0;
  private playingStep = -1;

  constructor(private c: Controller) {
    this.header = h('div', { class: 'grid-row grid-header', 'aria-hidden': 'true' });
    this.body = h('div', { class: 'grid-body' });
    this.el = h(
      'section',
      { class: 'grid-wrap panel', 'aria-label': 'Step sequencer' },
      h(
        'p',
        { class: 'hint', id: 'grid-hint' },
        'Click a step to toggle it · Shift-click (or A) for an accent · Arrow keys move · Drop an audio file on a track to load it',
      ),
      h('div', { class: 'grid-scroll' }, h('div', { class: 'grid' }, this.header, this.body)),
    );
    this.buildRows();
  }

  private buildRows(): void {
    this.rows = TRACK_IDS.map((track, ti) => {
      const nameBtn = h(
        'button',
        {
          type: 'button',
          class: 'track-name',
          title: `Edit ${TRACK_LABELS[track]} sound`,
          onClick: () => this.c.selectTrack(track),
        },
        TRACK_LABELS[track],
      );
      const mute = h('button', { type: 'button', class: 'ms mute', title: `Mute ${TRACK_LABELS[track]}`, onClick: () => this.c.toggleMute(track) }, 'M');
      const solo = h('button', { type: 'button', class: 'ms solo', title: `Solo ${TRACK_LABELS[track]}`, onClick: () => this.c.toggleSolo(track) }, 'S');
      const led = h('span', { class: 'led', 'aria-hidden': 'true' });
      const stepsEl = h('div', { class: 'steps', role: 'group', 'aria-label': `${TRACK_LABELS[track]} steps` });
      const el = h(
        'div',
        { class: 'grid-row', dataset: { track } },
        h('div', { class: 'track-head' }, led, nameBtn, h('div', { class: 'ms-group' }, mute, solo)),
        stepsEl,
      );
      el.style.setProperty('--track-color', `var(--c-${track})`);
      this.attachDrop(el, track);
      stepsEl.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.step');
        if (!btn) return;
        const step = Number(btn.dataset.step);
        this.focusTrack = ti;
        this.focusStep = step;
        this.c.toggleStep(track, step, e.shiftKey);
      });
      stepsEl.addEventListener('keydown', (e) => this.onKey(e, ti));
      return { track, el, nameBtn, mute, solo, led, steps: [] };
    });
    this.body.replaceChildren(...this.rows.map((r) => r.el));
  }

  private attachDrop(el: HTMLElement, track: TrackId): void {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-target');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      void this.c.importSampleFile(track, file);
    });
  }

  private rebuildSteps(length: number): void {
    this.length = length;
    this.headerCells = Array.from({ length }, (_, i) => {
      const p = stepPosition(i);
      const cls = `hcell${isBeatStart(i) ? ' beat-start' : ''}${isBarStart(i) ? ' bar-start' : ''}`;
      return h('span', { class: cls }, isBarStart(i) ? String(p.bar) : isBeatStart(i) ? `.${p.beat}` : '·');
    });
    this.header.replaceChildren(h('div', { class: 'track-head' }), h('div', { class: 'steps' }, this.headerCells));
    for (const row of this.rows) {
      row.steps = Array.from({ length }, (_, i) => {
        const p = stepPosition(i);
        const cls = `step${isBeatStart(i) ? ' beat-start' : ''}${isBarStart(i) ? ' bar-start' : ''}${p.beat % 2 === 0 ? ' even-beat' : ''}`;
        return h('button', { type: 'button', class: cls, dataset: { step: String(i) }, tabindex: -1 });
      });
      row.el.querySelector('.steps')!.replaceChildren(...row.steps);
    }
    this.el.style.setProperty('--steps', String(length));
    this.focusStep = Math.min(this.focusStep, length - 1);
    this.playingStep = -1;
  }

  private onKey(e: KeyboardEvent, ti: number): void {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.step');
    if (!btn) return;
    let t = ti;
    let s = Number(btn.dataset.step);
    switch (e.key) {
      case 'ArrowRight':
        s = (s + 1) % this.length;
        break;
      case 'ArrowLeft':
        s = (s - 1 + this.length) % this.length;
        break;
      case 'ArrowDown':
        t = Math.min(this.rows.length - 1, t + 1);
        break;
      case 'ArrowUp':
        t = Math.max(0, t - 1);
        break;
      case 'Home':
        s = 0;
        break;
      case 'End':
        s = this.length - 1;
        break;
      case 'a':
      case 'A':
        this.c.toggleStep(this.rows[ti].track, s, true);
        e.preventDefault();
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.focusTrack = t;
    this.focusStep = s;
    this.applyRovingTabindex();
    this.rows[t].steps[s].focus();
  }

  private applyRovingTabindex(): void {
    this.rows.forEach((r, ti) =>
      r.steps.forEach((b, si) => {
        const v = ti === this.focusTrack && si === this.focusStep ? '0' : '-1';
        if (b.getAttribute('tabindex') !== v) b.setAttribute('tabindex', v);
      }),
    );
  }

  update(s: State): void {
    const section = s.doc.sections[s.doc.activeSection];
    if (section.length !== this.length) this.rebuildSteps(section.length);
    const anySolo = TRACK_IDS.some((t) => s.doc.tracks[t].solo);
    for (const row of this.rows) {
      const sound = s.doc.tracks[row.track];
      const values = section.steps[row.track];
      row.steps.forEach((b, i) => {
        const v = values[i] ?? 0;
        toggleClass(b, 'on', v > 0);
        toggleClass(b, 'accent', v === 2);
        const pressed = String(v > 0);
        if (b.getAttribute('aria-pressed') !== pressed) b.setAttribute('aria-pressed', pressed);
        const p = stepPosition(i);
        const label = `${TRACK_LABELS[row.track]}, step ${i + 1} (bar ${p.bar} beat ${p.beat}), ${v === 2 ? 'accent' : v ? 'on' : 'off'}`;
        if (b.getAttribute('aria-label') !== label) b.setAttribute('aria-label', label);
      });
      toggleClass(row.mute, 'active', sound.mute);
      toggleClass(row.solo, 'active', sound.solo);
      row.mute.setAttribute('aria-pressed', String(sound.mute));
      row.solo.setAttribute('aria-pressed', String(sound.solo));
      row.mute.setAttribute('aria-label', `Mute ${TRACK_LABELS[row.track]}`);
      row.solo.setAttribute('aria-label', `Solo ${TRACK_LABELS[row.track]}`);
      toggleClass(row.el, 'silenced', sound.mute || (anySolo && !sound.solo));
      toggleClass(row.el, 'selected', s.selectedTrack === row.track);
      toggleClass(row.nameBtn, 'active', s.selectedTrack === row.track);
      row.nameBtn.setAttribute('aria-pressed', String(s.selectedTrack === row.track));
    }
    this.applyRovingTabindex();
    if (s.transport !== 'playing') this.setPlaying(-1);
  }

  /** Highlight the audible step (called every animation frame while playing). */
  setPlaying(step: number): void {
    if (step === this.playingStep) return;
    const prev = this.playingStep;
    this.playingStep = step;
    const section = this.c.state.doc.sections[this.c.state.doc.activeSection];
    for (const row of this.rows) {
      if (prev >= 0 && row.steps[prev]) row.steps[prev].classList.remove('playing');
      if (step >= 0 && row.steps[step]) {
        row.steps[step].classList.add('playing');
        // Flash the track LED when it fires on this step.
        if (section.steps[row.track][step] > 0) {
          row.led.classList.remove('hit');
          void row.led.offsetWidth;
          row.led.classList.add('hit');
        }
      }
    }
    if (prev >= 0 && this.headerCells[prev]) this.headerCells[prev].classList.remove('playing');
    if (step >= 0 && this.headerCells[step]) this.headerCells[step].classList.add('playing');
  }

  get playing(): number {
    return this.playingStep;
  }

  stepButton(track: TrackId, step: number): HTMLButtonElement | undefined {
    return this.rows.find((r) => r.track === track)?.steps[step];
  }
}

