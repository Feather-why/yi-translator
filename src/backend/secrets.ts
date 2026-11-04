import { getBackendDatabase } from './storage';

export const SECRETS_STORAGE_KEY = 'backend.secrets';

interface CipherRecord { version: 1; iv: string; data: string }
interface StorageArea {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

let memoryDeviceKey: Promise<CryptoKey> | undefined;

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode(value: string): ArrayBuffer {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)).buffer;
}

async function deviceKey(): Promise<CryptoKey> {
  const db = await getBackendDatabase();
  const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
    const request = db.transaction('meta', 'readonly').objectStore('meta').get('device.secrets-key');
    request.onsuccess = () => resolve(request.result as CryptoKey | undefined);
    request.onerror = () => reject(new Error('读取设备密钥失败'));
  });
  if (existing) return existing;
  const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('meta', 'readwrite');
    const store = transaction.objectStore('meta');
    const request = store.get('device.secrets-key');
    let selected = candidate;
    request.onsuccess = () => {
      // 多个启动任务并发时，只保留第一个事务写入的不可导出密钥。
      if (request.result) selected = request.result as CryptoKey;
      else store.put(candidate, 'device.secrets-key');
    };
    transaction.oncomplete = () => resolve(selected);
    transaction.onabort = () => reject(new Error('保存设备密钥失败'));
    transaction.onerror = () => reject(new Error('保存设备密钥失败'));
  });
}

export class SecretVault {
  private readonly key: Promise<CryptoKey>;
  private readonly storage: StorageArea;
  private mutations: Promise<void> = Promise.resolve();

  constructor(options: { memory?: boolean; storage?: StorageArea } = {}) {
    if (options.memory === true) {
      memoryDeviceKey ??= crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      this.key = memoryDeviceKey;
      const local: Record<string, unknown> = {};
      this.storage = options.storage ?? {
        get: async (key) => ({ [key]: structuredClone(local[key]) }),
        set: async (items) => { Object.assign(local, structuredClone(items)); },
      };
    } else {
      this.key = deviceKey();
      this.storage = options.storage ?? chrome.storage.local;
    }
    // 后台仍会通过 ready() 看到失败，附加处理仅防止构造和 ready 之间出现未处理拒绝。
    void this.key.catch(() => undefined);
  }

  async ready(): Promise<void> { await this.key; }

  async get(providerId: string): Promise<Record<string, string>> {
    await this.mutations;
    const stored = await this.storage.get(SECRETS_STORAGE_KEY);
    const records = stored[SECRETS_STORAGE_KEY] as Record<string, CipherRecord> | undefined;
    const record = records && Object.hasOwn(records, providerId) ? records[providerId] : undefined;
    if (!record) return {};
    try {
      if (record.version !== 1 || typeof record.iv !== 'string' || typeof record.data !== 'string') throw new Error();
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(record.iv), additionalData: new TextEncoder().encode(providerId) }, await this.key, decode(record.data));
      const result: unknown = JSON.parse(new TextDecoder().decode(plain));
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.values(result).every((value) => typeof value === 'string')) throw new Error();
      return result as Record<string, string>;
    } catch { throw new Error('无法解密本机服务密钥，请重新保存该服务配置'); }
  }

  async set(providerId: string, secrets: Record<string, string>): Promise<void> {
    if (!providerId || !Object.values(secrets).every((value) => typeof value === 'string')) throw new Error('服务密钥格式无效');
    const values = structuredClone(secrets);
    const mutation = this.mutations.then(async () => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(providerId) }, await this.key, new TextEncoder().encode(JSON.stringify(values)));
      const stored = await this.storage.get(SECRETS_STORAGE_KEY);
      const previous = stored[SECRETS_STORAGE_KEY];
      const records = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous as Record<string, CipherRecord> : {};
      const record: CipherRecord = { version: 1, iv: encode(iv), data: encode(new Uint8Array(cipher)) };
      await this.storage.set({ [SECRETS_STORAGE_KEY]: { ...records, [providerId]: record } });
    });
    this.mutations = mutation.catch(() => undefined);
    await mutation;
  }

  async remove(providerId: string): Promise<void> {
    if (typeof providerId !== 'string' || !providerId) throw new Error('服务标识无效');
    const mutation = this.mutations.then(async () => {
      const stored = await this.storage.get(SECRETS_STORAGE_KEY);
      const previous = stored[SECRETS_STORAGE_KEY];
      const records = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous } as Record<string, CipherRecord> : {};
      delete records[providerId];
      await this.storage.set({ [SECRETS_STORAGE_KEY]: records });
    });
    this.mutations = mutation.catch(() => undefined);
    await mutation;
  }
}
