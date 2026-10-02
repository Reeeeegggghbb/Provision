import type { ToastKind } from '../controller';
import { h, icon } from './dom';

export class Toasts {
  readonly el: HTMLElement;

  constructor() {
    this.el = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  }

  show(message: string, kind: ToastKind = 'info'): void {
    const close = () => item.remove();
    const item = h(
      'div',
      { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : undefined },
      h('span', null, message),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Dismiss', onClick: close }, icon('close')),
    );
    this.el.append(item);
    while (this.el.children.length > 4) this.el.firstElementChild?.remove();
    setTimeout(close, kind === 'error' ? 9000 : kind === 'warning' ? 7000 : 4000);
  }
}
