import { validTranslation } from './validation';

export interface StoredTranslation {
  text: string;
  provider: string;
  version?: string;
}
export interface StoredMemorySyncEntry { key: string; updatedAt: number; deleted?: boolean; value?: { sourceLang: string; targetLang: string; source: string; target: string } }
interface MemoryRecord extends StoredTranslation { key: string; updatedAt?: number; deleted?: boolean; sourceLang?: string; targetLang?: string; source?: string }

interface CacheEntry extends StoredTranslation {
  key: string;
  bytes: number;
  accessedAt: number;
}

const DATABASE = 'translate-backend';
const DEFAULT_CACHE_BYTES = 200 * 1024 * 1024;
let databasePromise: Promise<IDBDatabase> | undefined;

/** 缓存与设备密钥共用本机数据库，密钥从不经过 storage.sync。 */
export function getBackendDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('当前环境不支持 IndexedDB'));
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const cache = db.createObjectStore('cache', { keyPath: 'key' });
      cache.createIndex('accessedAt', 'accessedAt');
      db.createObjectStore('memory', { keyPath: 'key' });
      db.createObjectStore('meta');
    };
    request.onerror = () => { databasePromise = undefined; reject(new Error('无法打开后端本地数据库')); };
    request.onblocked = () => { databasePromise = undefined; reject(new Error('后端数据库升级被其他页面阻塞')); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); databasePromise = undefined; };
      resolve(db);
    };
  });
  return databasePromise;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('读取本地数据库失败'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('本地数据库事务未完成'));
    transaction.onerror = () => reject(transaction.error ?? new Error('写入本地数据库失败'));
  });
  void done.catch(() => undefined);
  return done;
}

async function keyFor(parts: string[]): Promise<string> {
  // JSON 元组避免原文包含分隔符时产生歧义，也不在索引里保留敏感原文。
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function translation(entry: StoredTranslation | undefined): StoredTranslation | undefined {
  if (!entry) return undefined;
  return { text: entry.text, provider: entry.provider, ...(entry.version === undefined ? {} : { version: entry.version }) };
}

export class BackendStorage {
  private readonly memory: boolean;
  private readonly maxBytes: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly memories = new Map<string, MemoryRecord>();
  private memoryBytes = 0;
  private accessClock = 0;
  private accesses = new Map<string, number>();
  private accessTimer?: ReturnType<typeof setTimeout>;
  private accessFlush?: Promise<void>;

  constructor(options: { memory?: boolean; maxBytes?: number } = {}) {
    this.memory = options.memory === true;
    this.maxBytes = options.maxBytes ?? DEFAULT_CACHE_BYTES;
    if (!Number.isFinite(this.maxBytes) || this.maxBytes < 0) throw new Error('缓存容量必须是非负有限数值');
  }

  async ready(): Promise<void> { if (!this.memory) await getBackendDatabase(); }

  async cacheGet(sourceLang: string, targetLang: string, tier: 'fast' | 'accurate', text: string): Promise<StoredTranslation | undefined> {
    const key = await keyFor(['cache', sourceLang, targetLang, tier, text]);
    if (this.memory) {
      const entry = this.cache.get(key);
      if (entry) { this.cache.delete(key); this.cache.set(key, entry); }
      return translation(entry);
    }
    const db = await getBackendDatabase();
    const transaction = db.transaction('cache', 'readonly');
    const done = transactionDone(transaction);
    const store = transaction.objectStore('cache');
    const entry = await requestValue<CacheEntry | undefined>(store.get(key));
    await done;
    if (entry) this.touch(key);
    return translation(entry);
  }

  private touch(key: string) {
    this.accesses.set(key, this.nextAccess());
    // 访问时间是近似LRU元数据，不能让每次缓存命中都等一次写事务。
    if (this.accesses.size >= 256) { void this.flushAccesses().catch(() => undefined); return; }
    if (this.accessTimer === undefined) this.accessTimer = setTimeout(() => { this.accessTimer = undefined; void this.flushAccesses().catch(() => undefined); }, 500);
  }

  private async flushAccesses(): Promise<void> {
    if (this.accessFlush) { await this.accessFlush.catch(() => undefined); return this.flushAccesses(); }
    if (this.accessTimer !== undefined) clearTimeout(this.accessTimer);
    this.accessTimer = undefined;
    if (!this.accesses.size) return;
    const accesses = this.accesses; this.accesses = new Map();
    const work = (async () => {
      const db = await getBackendDatabase();
      const transaction = db.transaction('cache', 'readwrite'), done = transactionDone(transaction);
      const store = transaction.objectStore('cache');
      for (const [key, accessedAt] of accesses) {
        const read = store.get(key);
        read.onsuccess = () => {
          const entry = read.result as CacheEntry | undefined;
          // 条目可能已被淘汰或替换；不复活旧值，也不覆盖新译文与容量统计。
          if (entry && entry.accessedAt < accessedAt) store.put({ ...entry, accessedAt });
        };
      }
      await done;
    })();
    this.accessFlush = work;
    try { await work; } finally { if (this.accessFlush === work) this.accessFlush = undefined; }
  }

  async cachePut(sourceLang: string, targetLang: string, tier: 'fast' | 'accurate', text: string, value: StoredTranslation): Promise<void> {
    const key = await keyFor(['cache', sourceLang, targetLang, tier, text]);
    const bytes = new TextEncoder().encode(JSON.stringify({ key, ...value })).byteLength;
    if (bytes > this.maxBytes) return;
    const entry: CacheEntry = { ...value, key, bytes, accessedAt: this.nextAccess() };
    if (this.memory) {
      this.memoryBytes -= this.cache.get(key)?.bytes ?? 0;
      this.cache.delete(key);
      this.cache.set(key, entry);
      this.memoryBytes += bytes;
      while (this.memoryBytes > this.maxBytes) {
        const oldest = this.cache.entries().next().value as [string, CacheEntry] | undefined;
        if (!oldest) break;
        this.cache.delete(oldest[0]);
        this.memoryBytes -= oldest[1].bytes;
      }
      return;
    }
    // 新增条目触发淘汰前，先合并最近命中的访问时间；写失败仍由原缓存写路径报告。
    await this.flushAccesses().catch(() => undefined);
    const db = await getBackendDatabase();
    const transaction = db.transaction(['cache', 'meta'], 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore('cache');
    const meta = transaction.objectStore('meta');
    const old = await requestValue<CacheEntry | undefined>(store.get(key));
    const previousBytes = await requestValue<number | undefined>(meta.get('cache.bytes'));
    let total = Math.max(0, (previousBytes ?? 0) - (old?.bytes ?? 0)) + bytes;
    store.put(entry);
    if (total <= this.maxBytes) meta.put(total, 'cache.bytes');
    else {
      // 容量与逐条淘汰在同一事务内完成，多个翻译请求不会互相覆盖总量。
      const cursorRequest = store.index('accessedAt').openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || total <= this.maxBytes) { meta.put(total, 'cache.bytes'); return; }
        total = Math.max(0, total - (cursor.value as CacheEntry).bytes);
        cursor.delete();
        cursor.continue();
      };
    }
    await done;
  }

  async tmGet(sourceLang: string, targetLang: string, text: string): Promise<StoredTranslation | undefined> {
    const key = await keyFor(['memory', sourceLang, targetLang, text]);
    if (this.memory) { const record = this.memories.get(key); return record?.deleted ? undefined : translation(record); }
    const db = await getBackendDatabase();
    const transaction = db.transaction('memory', 'readonly');
    const done = transactionDone(transaction);
    const result = await requestValue<MemoryRecord | undefined>(transaction.objectStore('memory').get(key));
    await done;
    return result?.deleted ? undefined : translation(result);
  }

  async tmPut(sourceLang: string, targetLang: string, source: string, target: string, updatedAt = Date.now()): Promise<void> {
    const key = await keyFor(['memory', sourceLang, targetLang, source]);
    const value: MemoryRecord = { key, text: target, provider: 'memory', sourceLang, targetLang, source, updatedAt };
    if (this.memory) { this.memories.set(key, value); return; }
    const db = await getBackendDatabase();
    const transaction = db.transaction('memory', 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore('memory').put(value);
    await done;
  }

  async exportEntries(): Promise<StoredMemorySyncEntry[]> {
    let records: MemoryRecord[];
    if (this.memory) records = [...this.memories.values()];
    else {
      const transaction = (await getBackendDatabase()).transaction('memory', 'readonly');
      const done = transactionDone(transaction);
      records = await requestValue<MemoryRecord[]>(transaction.objectStore('memory').getAll());
      await done;
    }
    return records.flatMap<StoredMemorySyncEntry>((record) => {
      if (!record.key || !record.updatedAt) return [];
      if (record.deleted) return [{ key: record.key, updatedAt: record.updatedAt, deleted: true }];
      if (record.sourceLang === undefined || record.targetLang === undefined || record.source === undefined) return [];
      return [{ key: record.key, updatedAt: record.updatedAt, value: { sourceLang: record.sourceLang, targetLang: record.targetLang, source: record.source, target: record.text } }];
    });
  }

  async importEntries(entries: StoredMemorySyncEntry[]): Promise<void> {
    if (!Array.isArray(entries) || entries.length > 100_000) throw new Error('译文记忆同步数量无效');
    const records: MemoryRecord[] = [];
    for (const entry of entries) {
      if (!entry || !/^[a-f0-9]{64}$/.test(entry.key) || !Number.isFinite(entry.updatedAt) || entry.updatedAt < 0) throw new Error('译文记忆同步格式无效');
      if (entry.deleted) { records.push({ key: entry.key, text: '', provider: 'memory', deleted: true, updatedAt: entry.updatedAt }); continue; }
      const value = entry.value;
      if (!value || ![value.sourceLang, value.targetLang, value.source, value.target].every((field) => typeof field === 'string')
        || await keyFor(['memory', value.sourceLang, value.targetLang, value.source]) !== entry.key) throw new Error('译文记忆同步键不匹配');
      // 同步文件可能损坏或被编辑，不能让不合法的标签关系进入本机译文记忆。
      if (!validTranslation(value.source, value.target)) throw new Error('译文记忆同步占位符不匹配');
      records.push({ key: entry.key, updatedAt: entry.updatedAt, provider: 'memory', text: value.target, sourceLang: value.sourceLang, targetLang: value.targetLang, source: value.source });
    }
    if (this.memory) {
      for (const record of records) if ((this.memories.get(record.key)?.updatedAt ?? 0) <= record.updatedAt!) this.memories.set(record.key, record);
      return;
    }
    const transaction = (await getBackendDatabase()).transaction('memory', 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore('memory');
    for (const record of records) {
      const get = store.get(record.key);
      get.onsuccess = () => { if (((get.result as MemoryRecord | undefined)?.updatedAt ?? 0) <= record.updatedAt!) store.put(record); };
    }
    await done;
  }

  private nextAccess(): number {
    this.accessClock = Math.max(Date.now(), this.accessClock + 1);
    return this.accessClock;
  }
}
