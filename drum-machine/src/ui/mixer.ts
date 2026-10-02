import type { Controller, State } from '../controller';
import { defaultTrackSound } from '../model/defaults';
import { TRACK_IDS, TRACK_LABELS, type TrackId } from '../model/types';
import { h, toggleClass } from './dom';
import { formatDb, formatPan } from './format';
import { Slider } from './slider';

interface Strip {
  track: TrackId;
  el: HTMLElement;
  name: HTMLButtonElement;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
  volume: Slider;
  pan: Slider;
}

export class MixerView {
  readonly el: HTMLElement;
  private strips: Strip[];

  constructor(c: Controller) {
    this.strips = TRACK_IDS.map((track) => {
      const label = TRACK_LABELS[track];
      const name = h('button', { type: 'button', class: 'strip-name', title: `Edit ${label} sound`, onClick: () => c.selectTrack(track) }, label);
      const mute = h('button', { type: 'button', class: 'ms mute', 'aria-label': `Mute ${label}`, title: 'Mute', onClick: () => c.toggleMute(track) }, 'M');
      const solo = h('button', { type: 'button', class: 'ms solo', 'aria-label': `Solo ${label}`, title: 'Solo', onClick: () => c.toggleSolo(track) }, 'S');
      const d = defaultTrackSound(track);
      const volume = new Slider({
        label: `${label} volume`,
        hideLabel: true,
        min: 0,
        max: 1.5,
        step: 0.01,
        format: formatDb,
        defaultValue: d.volume,
        title: 'Track volume (double-click to reset)',
        onInput: (v) => c.setTrackParam(track, 'volume', v),
        className: 'strip-volume',
      });
      const pan = new Slider({
        label: `${label} pan`,
        hideLabel: true,
        min: -1,
        max: 1,
        step: 0.01,
        format: formatPan,
        defaultValue: 0,
        title: 'Pan (double-click to centre)',
        onInput: (v) => c.setTrackParam(track, 'pan', v),
        className: 'strip-pan',
      });
      const el = h('div', { class: 'strip', dataset: { track } }, name, h('div', { class: 'ms-group' }, mute, solo), volume.el, pan.el);
      el.style.setProperty('--track-color', `var(--c-${track})`);
      return { track, el, name, mute, solo, volume, pan };
    });
    this.el = h(
      'section',
      { class: 'mixer panel', 'aria-labelledby': 'mixer-title' },
      h('div', { class: 'panel-head' }, h('h2', { id: 'mixer-title' }, 'Mixer'), h('span', { class: 'panel-sub' }, 'Volume · Pan · Mute · Solo')),
      h('div', { class: 'strips' }, this.strips.map((s) => s.el)),
    );
  }

  update(s: State): void {
    const anySolo = TRACK_IDS.some((t) => s.doc.tracks[t].solo);
    for (const strip of this.strips) {
      const t = s.doc.tracks[strip.track];
      strip.volume.set(t.volume);
      strip.pan.set(t.pan);
      toggleClass(strip.mute, 'active', t.mute);
      toggleClass(strip.solo, 'active', t.solo);
      strip.mute.setAttribute('aria-pressed', String(t.mute));
      strip.solo.setAttribute('aria-pressed', String(t.solo));
      toggleClass(strip.el, 'silenced', t.mute || (anySolo && !t.solo));
      toggleClass(strip.el, 'selected', s.selectedTrack === strip.track);
      strip.name.setAttribute('aria-pressed', String(s.selectedTrack === strip.track));
    }
  }
}
