import { ACCEPT_ATTRIBUTE, formatBytes } from '../audio/samples';
import type { Controller, State } from '../controller';
import { DEFAULT_SAMPLE, defaultTrackSound } from '../model/defaults';
import { TRACK_IDS, TRACK_LABELS, type TrackId, type TrackSound } from '../model/types';
import { h, icon, setText, toggleClass } from './dom';
import { formatDb, formatPan, formatSeconds, formatSigned } from './format';
import { Slider } from './slider';
import { Waveform } from './waveform';

type NumericKey = {
  [K in keyof TrackSound]: TrackSound[K] extends number ? K : never;
}[keyof TrackSound];

interface ParamDef {
  key: NumericKey;
  label: string;
  min: number;
  max: number;
  step?: number;
  log?: boolean;
  /** Display/slider scale relative to the stored value (e.g. 100 for percentages). */
  scale?: number;
  format: (v: number) => string;
  title: string;
}

const GROUPS: { title: string; params: ParamDef[] }[] = [
  {
    title: 'Tuning',
    params: [
      { key: 'semitones', label: 'Pitch', min: -24, max: 24, step: 1, format: (v) => formatSigned(v, ' st'), title: 'Coarse tuning in semitones' },
      { key: 'cents', label: 'Fine', min: -100, max: 100, step: 1, format: (v) => formatSigned(v, ' ct'), title: 'Fine tuning in cents (1/100 semitone)' },
    ],
  },
  {
    title: 'Envelope',
    params: [
      { key: 'attack', label: 'Attack', min: 0, max: 250, step: 1, scale: 1000, format: (v) => `${Math.round(v)} ms`, title: 'Fade-in time. Raise to soften the transient.' },
      { key: 'decay', label: 'Decay', min: 0.02, max: 4, log: true, format: formatSeconds, title: 'Time for the sound to fade to silence after the attack. Shorten to tighten the sound.' },
    ],
  },
  {
    title: 'Sample region',
    params: [
      { key: 'start', label: 'Start', min: 0, max: 99.5, step: 0.5, scale: 100, format: (v) => `${v.toFixed(1)}%`, title: 'Where playback begins inside the sample' },
      { key: 'end', label: 'End', min: 0.5, max: 100, step: 0.5, scale: 100, format: (v) => `${v.toFixed(1)}%`, title: 'Where playback ends inside the sample' },
    ],
  },
  {
    title: 'Pitch envelope',
    params: [
      { key: 'pitchEnvAmount', label: 'Amount', min: -24, max: 24, step: 0.5, format: (v) => (v === 0 ? 'Off' : formatSigned(v, ' st')), title: 'Start the hit this many semitones away from its pitch and glide back. Positive values add punch to kicks and toms.' },
      { key: 'pitchEnvTime', label: 'Time', min: 0.005, max: 1, log: true, format: formatSeconds, title: 'How long the pitch glide takes' },
    ],
  },
  {
    title: 'Tone & output',
    params: [
      { key: 'tone', label: 'Tone', min: -100, max: 100, step: 1, scale: 100, format: (v) => (v === 0 ? 'Neutral' : v < 0 ? `Dark ${-v}` : `Bright ${v}`), title: 'Negative values darken the sound (low-pass), positive values thin it out (high-pass)' },
      { key: 'volume', label: 'Volume', min: 0, max: 1.5, step: 0.01, format: formatDb, title: 'Track volume' },
      { key: 'pan', label: 'Pan', min: -1, max: 1, step: 0.01, format: formatPan, title: 'Stereo position' },
    ],
  },
];

export class EditorView {
  readonly el: HTMLElement;
  private trackSelect: HTMLSelectElement;
  private sampleSelect: HTMLSelectElement;
  private sampleInfo: HTMLElement;
  private removeBtn: HTMLButtonElement;
  private fileInput: HTMLInputElement;
  private waveform: Waveform;
  private sliders = new Map<NumericKey, { slider: Slider; def: ParamDef }>();
  private chokeSelect: HTMLSelectElement;
  private autoAudition: HTMLInputElement;
  private pendingBox: HTMLElement;
  private pendingInfo: HTMLElement;
  private pendingTitle: HTMLElement;
  private pendingWave: Waveform;
  private assignBtn: HTMLButtonElement;
  private busy: HTMLElement;
  private optionsKey = '';
  private title: HTMLElement;

  constructor(private c: Controller) {
    const track = () => c.state.selectedTrack;
    const maybeAudition = () => {
      if (this.autoAudition.checked && c.state.transport !== 'playing') void c.audition(track());
    };

    this.title = h('h2', { id: 'editor-title' }, 'Sound');
    this.trackSelect = h(
      'select',
      { class: 'select', 'aria-label': 'Track to edit', onChange: () => c.selectTrack(this.trackSelect.value as TrackId) },
      TRACK_IDS.map((t) => h('option', { value: t }, TRACK_LABELS[t])),
    );

    this.sampleSelect = h('select', {
      id: 'sample-select',
      class: 'select sample-select',
      onChange: () => {
        c.setTrackSample(track(), this.sampleSelect.value);
        maybeAudition();
      },
    });
    this.fileInput = h('input', {
      type: 'file',
      accept: ACCEPT_ATTRIBUTE,
      class: 'sr-only',
      id: 'sample-file',
      tabindex: -1,
      onChange: () => {
        const f = this.fileInput.files?.[0];
        if (f) void c.importSampleFile(track(), f);
        this.fileInput.value = '';
      },
    });
    this.removeBtn = h(
      'button',
      { type: 'button', class: 'btn subtle', title: 'Remove the custom sample from this track and go back to the built-in sound', onClick: () => c.removeTrackSample(track()) },
      'Use default',
    );
    this.sampleInfo = h('p', { class: 'sample-info' });
    this.waveform = new Waveform('Waveform of the selected sample with the playback region highlighted');

    // Pending import preview
    this.pendingTitle = h('strong', null);
    this.pendingInfo = h('span', { class: 'pending-info' });
    this.pendingWave = new Waveform('Waveform of the sample being imported', 'pending-wave');
    this.assignBtn = h('button', { type: 'button', class: 'btn primary', onClick: () => void c.assignPending() }, 'Assign');
    this.pendingBox = h(
      'div',
      { class: 'pending', role: 'region', 'aria-label': 'Sample preview', hidden: true },
      h('div', { class: 'pending-head' }, h('span', { class: 'badge' }, 'Preview'), this.pendingTitle, this.pendingInfo),
      this.pendingWave.el,
      h(
        'div',
        { class: 'pending-actions' },
        h('button', { type: 'button', class: 'btn', onClick: () => void c.previewPending() }, icon('play'), 'Preview'),
        this.assignBtn,
        h('button', { type: 'button', class: 'btn subtle', onClick: () => c.cancelPending() }, 'Cancel'),
      ),
    );
    this.busy = h('p', { class: 'busy', hidden: true, role: 'status' }, 'Decoding sample…');

    this.chokeSelect = h(
      'select',
      {
        id: 'choke-select',
        class: 'select',
        onChange: () => c.setTrackParam(track(), 'chokeGroup', Number(this.chokeSelect.value)),
      },
      h('option', { value: 0 }, 'None'),
      [1, 2, 3, 4].map((g) => h('option', { value: g }, `Group ${g}`)),
    );
    this.autoAudition = h('input', { type: 'checkbox', id: 'auto-audition', checked: true });

    const groups = GROUPS.map((g) =>
      h(
        'fieldset',
        { class: 'param-group' },
        h('legend', null, g.title),
        g.params.map((def) => {
          const scale = def.scale ?? 1;
          const slider = new Slider({
            label: def.label,
            min: def.min,
            max: def.max,
            step: def.step,
            log: def.log,
            format: def.format,
            title: `${def.title} (double-click to reset)`,
            onInput: (v) => c.setTrackParam(track(), def.key, v / scale),
            onCommit: () => maybeAudition(),
          });
          // Double-click restores this parameter's default for the current track.
          slider.input.addEventListener('dblclick', () => {
            const d = defaultTrackSound(track())[def.key];
            c.setTrackParam(track(), def.key, d);
          });
          this.sliders.set(def.key, { slider, def });
          return slider.el;
        }),
      ),
    );

    const drop = h(
      'div',
      { class: 'dropzone' },
      h('label', { for: 'sample-file', class: 'btn', role: 'button', tabindex: 0, onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.fileInput.click();
        }
      } }, icon('upload'), 'Import audio…'),
      h('span', { class: 'drop-hint' }, 'or drop a file here · WAV, MP3, OGG, FLAC, AAC… · stays on this device'),
      this.fileInput,
    );

    this.el = h(
      'section',
      { class: 'editor panel', 'aria-labelledby': 'editor-title' },
      h(
        'div',
        { class: 'panel-head' },
        this.title,
        this.trackSelect,
        h('button', { type: 'button', class: 'btn primary audition', title: 'Play this sound now', onClick: () => void c.audition(track()) }, icon('speaker'), 'Audition'),
        h('button', { type: 'button', class: 'btn subtle', title: 'Restore all sound settings for this track to their defaults', onClick: () => c.resetTrack(track()) }, icon('reset'), 'Reset'),
      ),
      h(
        'div',
        { class: 'sample-row' },
        h('label', { for: 'sample-select', class: 'group-label' }, 'Sample'),
        this.sampleSelect,
        this.removeBtn,
      ),
      this.sampleInfo,
      this.waveform.el,
      drop,
      this.busy,
      this.pendingBox,
      h('div', { class: 'params' }, groups),
      h(
        'div',
        { class: 'editor-foot' },
        h('label', { for: 'choke-select', class: 'group-label', title: 'Sounds in the same choke group cut each other off, like a closed hi-hat silencing an open one' }, 'Choke'),
        this.chokeSelect,
        h('label', { class: 'check', for: 'auto-audition', title: 'Play the sound when you release a control (only while stopped)' }, this.autoAudition, 'Audition on edit'),
      ),
      h(
        'p',
        { class: 'note' },
        'Tuning works like a classic sampler: lower pitches also play longer and higher pitches shorter. Pitch-preserving time-stretching is not used because it smears drum transients.',
      ),
    );

    this.attachDrop();
  }

  private attachDrop(): void {
    this.el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      this.el.classList.add('drop-target');
    });
    this.el.addEventListener('dragleave', (e) => {
      if (!this.el.contains(e.relatedTarget as Node)) this.el.classList.remove('drop-target');
    });
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('drop-target');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      void this.c.importSampleFile(this.c.state.selectedTrack, file);
    });
  }

  update(s: State): void {
    const track = s.selectedTrack;
    const sound = s.doc.tracks[track];
    this.el.style.setProperty('--track-color', `var(--c-${track})`);
    setText(this.title, `${TRACK_LABELS[track]}`);
    if (this.trackSelect.value !== track) this.trackSelect.value = track;

    // Sample options
    const options = this.c.sampleOptions();
    const key = options.map((o) => o.id).join('|');
    if (key !== this.optionsKey) {
      this.optionsKey = key;
      const groups = new Map<string, HTMLOptGroupElement>();
      for (const o of options) {
        let g = groups.get(o.group);
        if (!g) {
          g = h('optgroup', { label: o.group });
          groups.set(o.group, g);
        }
        g.append(h('option', { value: o.id }, o.name));
      }
      this.sampleSelect.replaceChildren(...groups.values());
    }
    if (this.sampleSelect.value !== sound.sampleId) this.sampleSelect.value = sound.sampleId;
    this.removeBtn.disabled = sound.sampleId === DEFAULT_SAMPLE[track];

    const meta = s.samples.find((m) => m.id === sound.sampleId);
    const dur = this.c.sampleDuration(sound.sampleId);
    setText(
      this.sampleInfo,
      `${this.c.sampleName(sound.sampleId)} · ${formatSeconds(dur)}${meta ? ` · ${formatBytes(meta.size)} · imported` : ' · built-in'}`,
    );
    this.waveform.set(this.c.peaks(sound.sampleId), sound.start, sound.end);

    for (const { slider, def } of this.sliders.values()) slider.set(sound[def.key] * (def.scale ?? 1));
    if (this.chokeSelect.value !== String(sound.chokeGroup)) this.chokeSelect.value = String(sound.chokeGroup);

    // Pending import
    const p = s.pending;
    this.busy.hidden = !s.importing;
    this.pendingBox.hidden = !p;
    if (p) {
      setText(this.pendingTitle, p.sample.name);
      setText(this.pendingInfo, `${formatSeconds(p.sample.buffer.duration)} · ${p.sample.buffer.numberOfChannels === 1 ? 'mono' : 'stereo'} · ${formatBytes(p.sample.size)}`);
      setText(this.assignBtn, `Assign to ${TRACK_LABELS[p.track]}`);
      this.pendingWave.set(p.sample.peaks);
    }
    toggleClass(this.el, 'has-pending', !!p);
  }
}
