import type { Controller, State } from '../controller';
import { BPM_MAX, BPM_MIN } from '../model/types';
import { stepPosition, swingPercent } from '../sequencer/timing';
import { h, icon, setText, toggleClass } from './dom';
import { formatBpm, formatDb } from './format';
import { Slider } from './slider';

export class TransportView {
  readonly el: HTMLElement;
  private playBtn: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private rewindBtn: HTMLButtonElement;
  private bpmInput: HTMLInputElement;
  private bpmSlider: HTMLInputElement;
  private swing: Slider;
  private master: Slider;
  private posBar: HTMLElement;
  private posBeat: HTMLElement;
  private posSub: HTMLElement;
  private audioPill: HTMLElement;

  constructor(private c: Controller) {
    const btn = (name: string, label: string, key: string, onClick: () => void, extra = '') =>
      h(
        'button',
        { type: 'button', class: `transport-btn ${extra}`, 'aria-label': label, title: `${label} (${key})`, onClick },
        icon(name),
      );
    this.rewindBtn = btn('rewind', 'Return to start', 'Home', () => c.rewind());
    this.playBtn = btn('play', 'Play', 'Space', () => void c.play(), 'play');
    this.pauseBtn = btn('pause', 'Pause', 'Space', () => c.pause());
    this.stopBtn = btn('stop', 'Stop', 'Esc', () => c.stop());

    this.bpmInput = h('input', {
      type: 'number',
      id: 'bpm-input',
      class: 'bpm-input',
      min: BPM_MIN,
      max: BPM_MAX,
      step: 1,
      inputmode: 'decimal',
      'aria-describedby': 'bpm-range-hint',
    });
    const commitBpm = () => {
      const v = Number(this.bpmInput.value);
      if (this.bpmInput.value.trim() === '' || !Number.isFinite(v)) {
        this.bpmInput.value = formatBpm(c.state.doc.bpm);
        return;
      }
      c.setBpm(v);
      this.bpmInput.value = formatBpm(c.state.doc.bpm);
    };
    this.bpmInput.addEventListener('change', commitBpm);
    this.bpmInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitBpm();
    });
    this.bpmSlider = h('input', {
      type: 'range',
      class: 'range bpm-slider',
      min: BPM_MIN,
      max: BPM_MAX,
      step: 1,
      'aria-label': 'Tempo',
      onInput: () => c.setBpm(Number(this.bpmSlider.value)),
    });
    const nudge = (d: number) => () => c.setBpm(Math.round(c.state.doc.bpm) + d);

    this.swing = new Slider({
      label: 'Swing',
      min: 50,
      max: 75,
      step: 1,
      format: (v) => `${Math.round(v)}%`,
      title: 'Delays every second 16th note. 50% = straight, 58% = light shuffle, 66% ≈ triplet swing. Double-click to reset.',
      defaultValue: 50,
      onInput: (v) => c.setSwing(v / 100),
      className: 'swing',
    });
    this.master = new Slider({
      label: 'Master',
      min: 0,
      max: 1.5,
      step: 0.01,
      format: formatDb,
      title: 'Master output level (a limiter protects against clipping). Double-click to reset.',
      defaultValue: 0.8,
      onInput: (v) => c.setMasterVolume(v),
      className: 'master',
    });

    this.posBar = h('span', { class: 'pos-num' });
    this.posBeat = h('span', { class: 'pos-num' });
    this.posSub = h('span', { class: 'pos-num' });
    this.audioPill = h('span', { class: 'audio-pill', role: 'status' });

    this.el = h(
      'section',
      { class: 'transport panel', 'aria-label': 'Transport' },
      h('div', { class: 'transport-buttons', role: 'group', 'aria-label': 'Playback controls' }, this.rewindBtn, this.playBtn, this.pauseBtn, this.stopBtn),
      h(
        'div',
        { class: 'tempo' },
        h('label', { for: 'bpm-input', class: 'tempo-label' }, 'Tempo'),
        h(
          'div',
          { class: 'tempo-readout' },
          h('button', { type: 'button', class: 'nudge', 'aria-label': 'Decrease tempo by 1 BPM', title: 'Tempo −1', onClick: nudge(-1) }, '−'),
          this.bpmInput,
          h('button', { type: 'button', class: 'nudge', 'aria-label': 'Increase tempo by 1 BPM', title: 'Tempo +1', onClick: nudge(1) }, '+'),
          h('span', { class: 'unit' }, 'BPM'),
        ),
        this.bpmSlider,
        h('span', { id: 'bpm-range-hint', class: 'sr-only' }, `Tempo between ${BPM_MIN} and ${BPM_MAX} beats per minute`),
      ),
      this.swing.el,
      this.master.el,
      h(
        'div',
        { class: 'position', 'aria-label': 'Playback position', title: 'Bar · Beat · 16th' },
        h('div', { class: 'pos-cell' }, h('span', { class: 'pos-label' }, 'Bar'), this.posBar),
        h('div', { class: 'pos-cell' }, h('span', { class: 'pos-label' }, 'Beat'), this.posBeat),
        h('div', { class: 'pos-cell' }, h('span', { class: 'pos-label' }, '16th'), this.posSub),
      ),
      this.audioPill,
    );
  }

  update(s: State): void {
    const playing = s.transport === 'playing';
    toggleClass(this.playBtn, 'active', playing);
    toggleClass(this.pauseBtn, 'active', s.transport === 'paused');
    this.playBtn.setAttribute('aria-pressed', String(playing));
    this.pauseBtn.setAttribute('aria-pressed', String(s.transport === 'paused'));
    if (document.activeElement !== this.bpmInput) {
      const v = formatBpm(s.doc.bpm);
      if (this.bpmInput.value !== v) this.bpmInput.value = v;
    }
    if (this.bpmSlider.value !== String(Math.round(s.doc.bpm))) this.bpmSlider.value = String(Math.round(s.doc.bpm));
    this.bpmSlider.setAttribute('aria-valuetext', `${formatBpm(s.doc.bpm)} BPM`);
    this.swing.set(swingPercent(s.doc.swing));
    this.master.set(s.doc.masterVolume);

    if (!playing) this.showPosition(this.c.sequencer.nextStep);

    const a = s.audioState;
    const [text, cls] =
      a === 'running'
        ? ['Audio on', 'ok']
        : a === 'interrupted'
          ? ['Audio interrupted', 'warn']
          : a === 'closed'
            ? ['Audio closed', 'warn']
            : ['Audio starts on Play', 'idle'];
    setText(this.audioPill, text);
    this.audioPill.dataset.state = cls;
  }

  showPosition(step: number): void {
    const p = stepPosition(step);
    setText(this.posBar, String(p.bar));
    setText(this.posBeat, String(p.beat));
    setText(this.posSub, String(p.sub));
  }
}
