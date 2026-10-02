import type { SampleMeta, SampleRecord, SavedPatternRecord } from '../model/types';

/**
 * Persistence backend. Everything stays in the browser: patterns, the working session and
 * imported audio (as the original file bytes) live in IndexedDB. Nothing is uploaded.
 */
export interface StorageBackend {
  readonly persistent: boolean;
  getSession(): Promise<unknown>;
  putSession(data: unknown): Promise<void>;
  listPatterns(): Promise<unknown[]>;
  getPattern(id: string): Promise<unknown>;
  putPattern(rec: SavedPatternRecord): Promise<void>;
  deletePattern(id: string): Promise<void>;
  listSampleMeta(): Promise<SampleMeta[]>;
  getSample(id: string): Promise<SampleRecord | undefined>;
  putSample(rec: SampleRecord): Promise<void>;
  deleteSample(id: string): Promise<void>;
}

const DB_NAME = 'drum-machine';
const DB_VERSION = 1;
const SESSION_KEY = 'current';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

export class IndexedDbStorage implements StorageBackend {
  readonly persistent = true;

  private constructor(private db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB, name = DB_NAME): Promise<IndexedDbStorage> {
    const request = factory.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('session')) db.createObjectStore('session');
      if (!db.objectStoreNames.contains('patterns')) db.createObjectStore('patterns', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('samples')) db.createObjectStore('samples', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sampleMeta')) db.createObjectStore('sampleMeta', { keyPath: 'id' });
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Database upgrade blocked by another tab'));
    });
    return new IndexedDbStorage(db);
  }

  private store(name: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }

  getSession(): Promise<unknown> {
    return req(this.store('session').get(SESSION_KEY));
  }

  async putSession(data: unknown): Promise<void> {
    const tx = this.db.transaction('session', 'readwrite');
    tx.objectStore('session').put(data, SESSION_KEY);
    await done(tx);
  }

  listPatterns(): Promise<unknown[]> {
    return req(this.store('patterns').getAll());
  }

  getPattern(id: string): Promise<unknown> {
    return req(this.store('patterns').get(id));
  }

  async putPattern(rec: SavedPatternRecord): Promise<void> {
    const tx = this.db.transaction('patterns', 'readwrite');
    tx.objectStore('patterns').put(rec);
    await done(tx);
  }

  async deletePattern(id: string): Promise<void> {
    const tx = this.db.transaction('patterns', 'readwrite');
    tx.objectStore('patterns').delete(id);
    await done(tx);
  }

  /** Metadata is stored separately so listing samples never loads the audio bytes. */
  listSampleMeta(): Promise<SampleMeta[]> {
    return req(this.store('sampleMeta').getAll()) as Promise<SampleMeta[]>;
  }

  getSample(id: string): Promise<SampleRecord | undefined> {
    return req(this.store('samples').get(id)) as Promise<SampleRecord | undefined>;
  }

  async putSample(rec: SampleRecord): Promise<void> {
    const tx = this.db.transaction(['samples', 'sampleMeta'], 'readwrite');
    tx.objectStore('samples').put(rec);
    const { data: _data, ...meta } = rec;
    tx.objectStore('sampleMeta').put(meta);
    await done(tx);
  }

  async deleteSample(id: string): Promise<void> {
    const tx = this.db.transaction(['samples', 'sampleMeta'], 'readwrite');
    tx.objectStore('samples').delete(id);
    tx.objectStore('sampleMeta').delete(id);
    await done(tx);
  }

  close(): void {
    this.db.close();
  }
}

/** Non-persistent fallback (e.g. IndexedDB disabled in a private window) and test double. */
export class MemoryStorage implements StorageBackend {
  readonly persistent = false;
  session: unknown = undefined;
  patterns = new Map<string, unknown>();
  samples = new Map<string, SampleRecord>();

  async getSession(): Promise<unknown> {
    return structuredClone(this.session);
  }
  async putSession(data: unknown): Promise<void> {
    this.session = structuredClone(data);
  }
  async listPatterns(): Promise<unknown[]> {
    return [...this.patterns.values()].map((p) => structuredClone(p));
  }
  async getPattern(id: string): Promise<unknown> {
    return structuredClone(this.patterns.get(id));
  }
  async putPattern(rec: SavedPatternRecord): Promise<void> {
    this.patterns.set(rec.id, structuredClone(rec));
  }
  async deletePattern(id: string): Promise<void> {
    this.patterns.delete(id);
  }
  async listSampleMeta(): Promise<SampleMeta[]> {
    return [...this.samples.values()].map(({ data: _d, ...m }) => m);
  }
  async getSample(id: string): Promise<SampleRecord | undefined> {
    return this.samples.get(id);
  }
  async putSample(rec: SampleRecord): Promise<void> {
    this.samples.set(rec.id, rec);
  }
  async deleteSample(id: string): Promise<void> {
    this.samples.delete(id);
  }
}

export async function openStorage(): Promise<StorageBackend> {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
    return await IndexedDbStorage.open();
  } catch {
    return new MemoryStorage();
  }
}
