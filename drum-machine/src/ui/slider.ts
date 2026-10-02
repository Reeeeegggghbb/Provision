import { h, setText, uniqueId } from './dom';

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step?: number;
  /** Logarithmic mapping (min must be > 0). */
  log?: boolean;
  format: (v: number) => string;
  title?: string;
  onInput: (v: number) => void;
  onCommit?: (v: number) => void;
  className?: string;
  /** Visually hide the label (it is still read by screen readers). */
  hideLabel?: boolean;
  /** Value restored on double-click. */
  defaultValue?: number;
}

const LOG_RES = 1000;

/** A labelled range input with a live value read-out. */
export class Slider {
  readonly el: HTMLDivElement;
  readonly input: HTMLInputElement;
  private output: HTMLOutputElement;
  private value = NaN;

  constructor(private opts: SliderOptions) {
    const id = uniqueId('slider');
    const step = opts.log ? 1 : (opts.step ?? 1);
    this.input = h('input', {
      type: 'range',
      id,
      min: opts.log ? 0 : opts.min,
      max: opts.log ? LOG_RES : opts.max,
      step,
      class: 'range',
    });
    this.output = h('output', { for: id, class: 'slider-value' });
    this.el = h(
      'div',
      { class: `slider ${opts.className ?? ''}`, title: opts.title },
      h('label', { for: id, class: opts.hideLabel ? 'sr-only' : 'slider-label' }, opts.label),
      this.input,
      this.output,
    );
    this.input.addEventListener('input', () => {
      const v = this.fromInput();
      this.value = v;
      this.render();
      opts.onInput(v);
    });
    this.input.addEventListener('change', () => opts.onCommit?.(this.fromInput()));
    if (opts.defaultValue !== undefined) {
      this.input.addEventListener('dblclick', () => {
        this.set(opts.defaultValue!);
        opts.onInput(opts.defaultValue!);
        opts.onCommit?.(opts.defaultValue!);
      });
    }
  }

  private fromInput(): number {
    const raw = Number(this.input.value);
    if (!this.opts.log) return raw;
    const { min, max } = this.opts;
    return min * Math.pow(max / min, raw / LOG_RES);
  }

  private toInput(v: number): string {
    if (!this.opts.log) return String(v);
    const { min, max } = this.opts;
    return String(Math.round((Math.log(v / min) / Math.log(max / min)) * LOG_RES));
  }

  private render(): void {
    const text = this.opts.format(this.value);
    setText(this.output, text);
    this.input.setAttribute('aria-valuetext', text);
  }

  set(v: number): void {
    if (v === this.value) return;
    this.value = v;
    const iv = this.toInput(v);
    if (this.input.value !== iv) this.input.value = iv;
    this.render();
  }

  setDisabled(disabled: boolean): void {
    this.input.disabled = disabled;
  }
}
