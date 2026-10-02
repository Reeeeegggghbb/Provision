import { h } from './dom';

/** Canvas waveform with an optional highlighted start/end region. */
export class Waveform {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private peaks: Float32Array | null = null;
  private start = 0;
  private end = 1;
  private observer: ResizeObserver | null = null;

  constructor(label: string, className = '') {
    this.canvas = h('canvas', { class: 'waveform-canvas', role: 'img', 'aria-label': label });
    this.el = h('div', { class: `waveform ${className}` }, this.canvas);
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.draw());
      this.observer.observe(this.el);
    }
  }

  set(peaks: Float32Array | null, start = 0, end = 1): void {
    if (peaks === this.peaks && start === this.start && end === this.end) return;
    this.peaks = peaks;
    this.start = start;
    this.end = end;
    this.draw();
  }

  draw(): void {
    let ctx: CanvasRenderingContext2D | null;
    try {
      ctx = this.canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, this.el.clientWidth);
    const hgt = Math.max(1, this.el.clientHeight);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(hgt * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(hgt * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const css = getComputedStyle(this.el);
    const active = css.getPropertyValue('--wave-active').trim() || '#4fd1c5';
    const dim = css.getPropertyValue('--wave-dim').trim() || '#3a4250';
    const region = css.getPropertyValue('--wave-region').trim() || 'rgba(79,209,197,0.08)';

    const x0 = this.start * w;
    const x1 = this.end * w;
    ctx.fillStyle = region;
    ctx.fillRect(x0, 0, x1 - x0, hgt);

    const mid = hgt / 2;
    if (this.peaks && this.peaks.length >= 2) {
      const n = this.peaks.length / 2;
      for (let x = 0; x < w; x++) {
        const b = Math.min(n - 1, Math.floor((x / w) * n));
        const min = this.peaks[b * 2];
        const max = this.peaks[b * 2 + 1];
        ctx.fillStyle = x >= x0 && x <= x1 ? active : dim;
        const top = mid - max * mid * 0.95;
        const bottom = mid - min * mid * 0.95;
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
      }
    }
    ctx.fillStyle = active;
    ctx.fillRect(Math.round(x0), 0, 2, hgt);
    ctx.fillRect(Math.round(x1) - 2, 0, 2, hgt);
  }

  dispose(): void {
    this.observer?.disconnect();
  }
}
