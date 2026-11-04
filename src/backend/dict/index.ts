import type { DictEntry } from '../../shared/protocol';
import { parseEcDictCsv } from './csv';

export interface DictionaryRow {
  word: string; phonetic?: string; translation: string; definition?: string; exchange?: string; tag?: string; collins?: number; oxford?: boolean;
}
export interface DictionaryOptions { memory?: boolean; entries?: DictionaryRow[]; fetch?: typeof fetch; sourceUrl?: string }
const formNames: Record<string, string> = { p: '过去式', d: '过去分词', i: '现在分词', '3': '第三人称单数', r: '比较级', t: '最高级', s: '复数' };
const normalize = (word: string) => word.normalize('NFKC').trim().toLowerCase();
const lines = (text = '') => text.replace(/\\n/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);

export function exchanges(value = ''): { lemma?: string; forms: Record<string, string> } {
  const forms: Record<string, string> = {}; let lemma: string | undefined;
  for (const item of value.split('/')) {
    const separator = item.indexOf(':'); if (separator < 1) continue;
    const type = item.slice(0, separator), word = item.slice(separator + 1).trim();
    if (!word) continue;
    if (type === '0') lemma = normalize(word);
    else if (formNames[type]) forms[formNames[type]!] = word;
  }
  return { ...(lemma ? { lemma } : {}), forms };
}

function entry(row: DictionaryRow, requested: string, lemma?: string): DictEntry {
  const parsed = exchanges(row.exchange);
  return { word: requested, ...(lemma && normalize(requested) !== lemma ? { lemma } : {}), phonetic: row.phonetic,
    translations: lines(row.translation), definitions: lines(row.definition), forms: parsed.forms,
    tags: row.tag?.split(/\s+/).filter(Boolean), collins: row.collins, oxford: row.oxford, source: 'ecdict' };
}
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); });
}
function complete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); transaction.onerror = () => reject(transaction.error); });
}

export class Dictionary {
  private database?: Promise<IDBDatabase>;
  private initialization?: Promise<void>;
  private words = new Map<string, DictionaryRow>();
  private forms = new Map<string, string>();
  private recent = new Map<string, DictEntry | null>();
  private imported = 0;
  private revision = 0;
  private explicitImport = 0;
  private lifecycle = 0;
  private commits = Promise.resolve();
  private error?: string;
  constructor(private options: DictionaryOptions = {}) {}
  ready(): Promise<void> {
    if (!this.initialization) {
      const work = this.initialize(this.lifecycle, this.explicitImport);
      const current = work.catch((error: unknown) => {
        // 首次资源读取可能晚于人工导入结束，不能清掉更新后的就绪状态。
        if (this.initialization === current) { this.error = '离线词典初始化失败'; this.initialization = undefined; }
        throw error;
      });
      this.initialization = current;
    }
    return this.initialization;
  }
  status() { return { entries: this.imported, ready: this.imported > 0, revision: this.revision, ...(this.error ? { error: this.error } : {}) }; }
  private open() {
    if (this.database) return this.database;
    const lifecycle = this.lifecycle;
    const work = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('当前环境不支持 IndexedDB')); return; }
      const operation = indexedDB.open('translate-ecdict', 1);
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
      operation.onupgradeneeded = () => {
        if (settled || lifecycle !== this.lifecycle) {
          try { operation.transaction?.abort(); } catch { /* 过期升级已经结束时也不能改新连接。 */ }
          return;
        }
        operation.result.createObjectStore('words', { keyPath: 'word' });
        operation.result.createObjectStore('forms'); operation.result.createObjectStore('meta');
      };
      operation.onsuccess = () => {
        // blocked会先拒绝Promise，但原open请求仍可能成功；这个旧连接必须自行关闭。
        if (settled || lifecycle !== this.lifecycle || this.database !== current) {
          operation.result.close(); fail(new Error('词典数据库状态已更新')); return;
        }
        settled = true; resolve(operation.result);
      };
      operation.onerror = () => fail(operation.error ?? new Error('词典数据库打开失败'));
      operation.onblocked = () => fail(new Error('词典数据库升级被阻塞'));
    });
    const current = work.catch((error: unknown) => { if (this.database === current) this.database = undefined; throw error; });
    this.database = current; return current;
  }
  private async initialize(lifecycle: number, explicitImport: number) {
    const current = () => lifecycle === this.lifecycle && explicitImport === this.explicitImport;
    if (!this.options.memory) {
      const db = await this.open();
      const count = await request(db.transaction('meta').objectStore('meta').get('count')) as number | undefined;
      if (!current()) return;
      if (count && !this.options.entries) { this.imported = count; this.revision++; this.error = undefined; return; }
    }
    if (this.options.entries) { await this.replace(this.normalized(this.options.entries), lifecycle, explicitImport); return; }
    const fetcher = this.options.fetch ?? globalThis.fetch.bind(globalThis);
    const url = this.options.sourceUrl ?? chrome.runtime.getURL('dict/ecdict-100k.json.gz');
    const response = await fetcher(url, { credentials: 'omit' });
    if (!response.ok || !response.body) throw new Error('离线词典资源不可用');
    const json: unknown = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
    if (!json || typeof json !== 'object' || !('entries' in json) || !Array.isArray(json.entries) || json.entries.length > 1000000) throw new Error('离线词典资源格式无效');
    const rows: DictionaryRow[] = json.entries.map((item: unknown) => {
      if (!Array.isArray(item) || typeof item[0] !== 'string' || typeof item[2] !== 'string') throw new Error('离线词典条目格式无效');
      return { word: item[0], phonetic: String(item[1] ?? ''), translation: item[2], definition: String(item[3] ?? ''), exchange: String(item[4] ?? ''), tag: String(item[5] ?? ''), collins: Number(item[6]) || undefined, oxford: item[7] === '1' };
    });
    if (current()) await this.replace(this.normalized(rows), lifecycle, explicitImport);
  }
  private normalized(rows: DictionaryRow[]) {
    if (!Array.isArray(rows) || rows.length > 1000000 || rows.some((row) => !row || typeof row.word !== 'string' || typeof row.translation !== 'string')) throw new Error('ECDICT 导入数据无效');
    return [...new Map(rows.map((row) => ({ ...row, word: normalize(row.word) })).filter((row) => row.word).map((row) => [row.word, row])).values()];
  }
  private replace(normalized: DictionaryRow[], lifecycle: number, bootstrapImport?: number): Promise<{ count: number }> {
    // 同一对象的替换按提交顺序写入；bootstrap只有在没有更新人工导入时才有权提交。
    const work = this.commits.then(async () => {
      if (lifecycle !== this.lifecycle) throw new Error('词典状态已更新');
      if (bootstrapImport !== undefined && bootstrapImport !== this.explicitImport) return { count: this.imported };
      if (this.options.memory) {
        this.words.clear(); this.forms.clear();
        for (const row of normalized) {
          this.words.set(row.word, row);
          for (const value of Object.values(exchanges(row.exchange).forms)) for (const form of value.split(',')) if (!this.forms.has(normalize(form))) this.forms.set(normalize(form), row.word);
        }
      } else {
        const db = await this.open();
        if (lifecycle !== this.lifecycle) throw new Error('词典状态已更新');
        if (bootstrapImport !== undefined && bootstrapImport !== this.explicitImport) return { count: this.imported };
        const transaction = db.transaction(['words', 'forms', 'meta'], 'readwrite'); const done = complete(transaction);
        const words = transaction.objectStore('words'), forms = transaction.objectStore('forms');
        words.clear(); forms.clear();
        for (const row of normalized) {
          words.put(row);
          for (const value of Object.values(exchanges(row.exchange).forms)) for (const form of value.split(',')) forms.put(row.word, normalize(form));
        }
        transaction.objectStore('meta').put(normalized.length, 'count'); await done;
      }
      if (lifecycle !== this.lifecycle) throw new Error('词典状态已更新');
      this.imported = normalized.length; this.revision++; this.error = undefined; this.recent.clear();
      return { count: normalized.length };
    });
    this.commits = work.then(() => undefined, () => undefined);
    return work;
  }
  async import(rows: DictionaryRow[]): Promise<{ count: number }> {
    const normalized = this.normalized(rows);
    this.explicitImport++;
    const work = this.replace(normalized, this.lifecycle);
    const initialized = work.then(() => undefined);
    this.initialization = initialized;
    void initialized.catch(() => { if (this.initialization === initialized) this.initialization = undefined; });
    return work;
  }
  importCsv(text: string) { return this.import(parseEcDictCsv(text)); }
  async lookup(word: string, lang = 'en', targetLang = 'zh-CN'): Promise<DictEntry | null> {
    if (!/^en(?:-|$)/i.test(lang) || !/^zh(?:-|$)/i.test(targetLang) || typeof word !== 'string' || word.length > 100) return null;
    await this.ready();
    const revision = this.revision, lifecycle = this.lifecycle;
    const key = normalize(word); if (!key) return null;
    if (this.recent.has(key)) return structuredClone(this.recent.get(key)!);
    const read = async (name: 'words' | 'forms', value: string): Promise<DictionaryRow | string | undefined> => this.options.memory
      ? (name === 'words' ? this.words.get(value) : this.forms.get(value))
      : request((await this.open()).transaction(name).objectStore(name).get(value));
    let row = await read('words', key) as DictionaryRow | undefined;
    const lemma = row ? exchanges(row.exchange).lemma : await read('forms', key) as string | undefined;
    if (lemma) row = await read('words', lemma) as DictionaryRow | undefined ?? row;
    const found = row ? entry(row, word, lemma ?? row.word) : null;
    if (lifecycle !== this.lifecycle) throw new Error('词典状态已更新');
    if (revision !== this.revision) return this.lookup(word, lang, targetLang);
    this.recent.set(key, found); while (this.recent.size > 256) this.recent.delete(this.recent.keys().next().value!);
    return structuredClone(found);
  }
  async dispose() {
    this.lifecycle++; this.initialization = undefined; this.recent.clear();
    const database = this.database; this.database = undefined;
    await this.commits;
    try { (await database)?.close(); } catch { /* 打开失败不妨碍释放；不能清掉期间新建的连接。 */ }
  }
}
