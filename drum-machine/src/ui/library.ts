import { formatBytes } from '../audio/samples';
import type { Controller, SavedPatternEntry, State } from '../controller';
import { h, icon, setText } from './dom';
import { formatSeconds } from './format';

/** Saved-pattern browser plus import/export and the custom-sample library. */
export class LibraryView {
  readonly el: HTMLElement;
  private list: HTMLUListElement;
  private sampleList: HTMLUListElement;
  private saveAsInput: HTMLInputElement;
  private importInput: HTMLInputElement;
  private embed: HTMLInputElement;
  private renaming: string | null = null;
  private confirmDelete: string | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private lastKey = '';
  private storageNote: HTMLElement;
  onClose: (() => void) | null = null;

  constructor(private c: Controller) {
    this.list = h('ul', { class: 'pattern-list', 'aria-label': 'Saved patterns' });
    this.sampleList = h('ul', { class: 'sample-list', 'aria-label': 'Imported samples' });
    this.saveAsInput = h('input', { type: 'text', id: 'save-as-name', class: 'text', maxlength: 80, placeholder: 'Pattern name' });
    this.importInput = h('input', {
      type: 'file',
      accept: '.json,application/json',
      class: 'sr-only',
      id: 'import-json',
      tabindex: -1,
      onChange: () => void this.importFile(),
    });
    this.embed = h('input', { type: 'checkbox', id: 'embed-samples', checked: true });
    this.storageNote = h('p', { class: 'note' });

    const saveAs = h(
      'form',
      {
        class: 'save-as',
        onSubmit: (e: Event) => {
          e.preventDefault();
          const name = this.saveAsInput.value.trim() || c.state.doc.name;
          void c.saveAs(name).then((ok) => {
            if (ok) this.saveAsInput.value = '';
          });
        },
      },
      h('label', { for: 'save-as-name', class: 'group-label' }, 'Save as new'),
      h('div', { class: 'inline' }, this.saveAsInput, h('button', { type: 'submit', class: 'btn primary' }, 'Save as')),
    );

    this.el = h(
      'aside',
      { class: 'library panel', id: 'library', 'aria-labelledby': 'library-title', hidden: true },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { id: 'library-title' }, 'Patterns'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close pattern library', onClick: () => this.onClose?.() }, icon('close')),
      ),
      h(
        'div',
        { class: 'lib-actions' },
        h('button', { type: 'button', class: 'btn', onClick: () => c.newBlankPattern(), title: 'Start a new empty pattern (current one stays in the library if saved)' }, 'New blank'),
        h('button', { type: 'button', class: 'btn', onClick: () => void c.restoreExamples(), title: 'Add the example patterns back to the library' }, 'Restore examples'),
      ),
      saveAs,
      this.list,
      h(
        'div',
        { class: 'lib-section' },
        h('h3', null, 'Import / export'),
        h(
          'div',
          { class: 'lib-actions' },
          h('button', { type: 'button', class: 'btn', onClick: () => void this.exportFile() }, 'Export JSON'),
          h('label', { for: 'import-json', class: 'btn', role: 'button', tabindex: 0, onKeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              this.importInput.click();
            }
          } }, 'Import JSON…'),
          this.importInput,
        ),
        h('label', { class: 'check', for: 'embed-samples' }, this.embed, 'Embed custom samples in export'),
      ),
      h('div', { class: 'lib-section' }, h('h3', null, 'Your samples'), this.sampleList),
      this.storageNote,
    );
  }

  private async exportFile(): Promise<void> {
    const json = await this.c.exportJson(this.embed.checked);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `${this.c.state.doc.name.replace(/[^\w\- ]+/g, '').trim() || 'pattern'}.drum.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async importFile(): Promise<void> {
    const f = this.importInput.files?.[0];
    this.importInput.value = '';
    if (!f) return;
    if (f.size > 200 * 1024 * 1024) {
      this.c.toast('That file is too large to be a pattern export.', 'error');
      return;
    }
    await this.c.importJson(await f.text());
  }

  private startConfirm(id: string): void {
    this.confirmDelete = id;
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = setTimeout(() => {
      this.confirmDelete = null;
      this.render(this.c.state, true);
    }, 4000);
    this.render(this.c.state, true);
  }

  private item(p: SavedPatternEntry, s: State): HTMLLIElement {
    const current = s.currentPatternId === p.id;
    if (this.renaming === p.id) {
      const input = h('input', { type: 'text', class: 'text', value: p.name, maxlength: 80, 'aria-label': `New name for ${p.name}` });
      const finish = async (commit: boolean) => {
        if (this.renaming !== p.id) return;
        this.renaming = null;
        if (commit && input.value.trim()) await this.c.renamePattern(p.id, input.value);
        this.render(this.c.state, true);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void finish(true);
        if (e.key === 'Escape') {
          e.stopPropagation();
          void finish(false);
        }
      });
      input.addEventListener('blur', () => void finish(true));
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
      return h('li', { class: 'pattern-item renaming' }, input);
    }
    const name = h('span', { class: 'pattern-name' }, p.name, p.corrupt ? h('span', { class: 'badge warn' }, 'corrupted') : null, current ? h('span', { class: 'badge' }, 'current') : null);
    const confirming = this.confirmDelete === p.id;
    return h(
      'li',
      { class: `pattern-item${current ? ' current' : ''}` },
      name,
      h(
        'div',
        { class: 'item-actions' },
        h('button', { type: 'button', class: 'btn small', disabled: p.corrupt, 'aria-label': `Load ${p.name}`, onClick: () => void this.c.loadPattern(p.id) }, 'Load'),
        h('button', { type: 'button', class: 'btn small subtle', 'aria-label': `Rename ${p.name}`, onClick: () => {
          this.renaming = p.id;
          this.render(this.c.state, true);
        } }, 'Rename'),
        h('button', { type: 'button', class: 'btn small subtle', disabled: p.corrupt, 'aria-label': `Duplicate ${p.name}`, onClick: () => void this.c.duplicatePattern(p.id) }, 'Duplicate'),
        h(
          'button',
          {
            type: 'button',
            class: `btn small ${confirming ? 'danger' : 'subtle'}`,
            'aria-label': confirming ? `Confirm delete ${p.name}` : `Delete ${p.name}`,
            onClick: () => {
              if (confirming) {
                this.confirmDelete = null;
                void this.c.deletePattern(p.id);
              } else this.startConfirm(p.id);
            },
          },
          confirming ? 'Confirm' : icon('trash'),
        ),
      ),
    );
  }

  update(s: State): void {
    this.render(s, false);
  }

  private render(s: State, force: boolean): void {
    const key = JSON.stringify([s.savedPatterns, s.currentPatternId, s.samples.map((m) => m.id), this.renaming, this.confirmDelete]);
    if (!force && key === this.lastKey) return;
    // Don't rebuild under an active rename field (it would steal focus).
    if (!force && this.renaming) return;
    this.lastKey = key;
    this.list.replaceChildren(
      ...(s.savedPatterns.length ? s.savedPatterns.map((p) => this.item(p, s)) : [h('li', { class: 'empty' }, 'No saved patterns yet.')]),
    );
    this.sampleList.replaceChildren(
      ...(s.samples.length
        ? s.samples.map((m) =>
            h(
              'li',
              { class: 'sample-item' },
              h('span', { class: 'pattern-name' }, m.name, s.brokenSamples.has(m.id) ? h('span', { class: 'badge warn' }, 'unreadable') : null),
              h('span', { class: 'meta' }, `${formatSeconds(m.duration)} · ${formatBytes(m.size)}`),
              h('button', { type: 'button', class: 'btn small subtle', 'aria-label': `Delete sample ${m.name}`, onClick: () => void this.c.deleteSample(m.id) }, icon('trash')),
            ),
          )
        : [h('li', { class: 'empty' }, 'Imported samples appear here. Import one from the sound editor.')]),
    );
    setText(
      this.storageNote,
      s.persistent
        ? 'Patterns and samples are stored only in this browser (IndexedDB). Nothing is uploaded.'
        : 'Browser storage is unavailable: changes are kept only until this tab closes.',
    );
  }
}
