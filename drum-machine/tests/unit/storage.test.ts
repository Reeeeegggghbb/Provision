import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { blankPattern } from '../../src/model/defaults';
import { IndexedDbStorage, MemoryStorage, type StorageBackend } from '../../src/storage/storage';

const record = (id: string, name = id) => ({ id, name, createdAt: 1, updatedAt: 2, doc: blankPattern(name) });

describe.each([
  ['IndexedDbStorage', async () => IndexedDbStorage.open(new IDBFactory(), 'test-db')],
  ['MemoryStorage', async () => new MemoryStorage()],
] as [string, () => Promise<StorageBackend>][])('%s', (_name, make) => {
  let store: StorageBackend;
  beforeEach(async () => {
    store = await make();
  });

  it('stores and retrieves the session', async () => {
    expect(await store.getSession()).toBeUndefined();
    await store.putSession({ doc: blankPattern('S'), currentPatternId: null });
    expect(((await store.getSession()) as { doc: { name: string } }).doc.name).toBe('S');
  });

  it('saves, lists, overwrites and deletes patterns', async () => {
    await store.putPattern(record('a', 'Alpha'));
    await store.putPattern(record('b', 'Beta'));
    await store.putPattern(record('a', 'Alpha 2'));
    const list = (await store.listPatterns()) as { id: string; name: string }[];
    expect(list.map((p) => p.name).sort()).toEqual(['Alpha 2', 'Beta']);
    await store.deletePattern('a');
    expect(await store.getPattern('a')).toBeUndefined();
    expect(await store.listPatterns()).toHaveLength(1);
  });

  it('stores audio bytes separately from listable metadata', async () => {
    const data = new Uint8Array([1, 2, 3, 4]).buffer;
    await store.putSample({ id: 'user:1', name: 'k.wav', mimeType: 'audio/wav', size: 4, duration: 0.2, createdAt: 1, data });
    const metas = await store.listSampleMeta();
    expect(metas).toEqual([{ id: 'user:1', name: 'k.wav', mimeType: 'audio/wav', size: 4, duration: 0.2, createdAt: 1 }]);
    const rec = await store.getSample('user:1');
    expect(new Uint8Array(rec!.data)).toEqual(new Uint8Array([1, 2, 3, 4]));
    await store.deleteSample('user:1');
    expect(await store.listSampleMeta()).toEqual([]);
    expect(await store.getSample('user:1')).toBeUndefined();
  });
});

describe('IndexedDbStorage persistence', () => {
  it('keeps data across re-opening the database (page refresh)', async () => {
    const factory = new IDBFactory();
    const a = await IndexedDbStorage.open(factory, 'persist');
    await a.putPattern(record('x', 'Kept'));
    a.close();
    const b = await IndexedDbStorage.open(factory, 'persist');
    expect(((await b.getPattern('x')) as { name: string }).name).toBe('Kept');
  });
});
