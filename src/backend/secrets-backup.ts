import { ProviderError } from './providers/types';
import type { SecretVault } from './secrets';

export interface EncryptedSecrets {
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}
const ITERATIONS = 600_000;
const AAD = new TextEncoder().encode('translate.secrets-backup.v1');
const failure = (message: string): never => { throw new ProviderError({ code: 'bad_input', message, retryable: false }); };

function base64(data: Uint8Array): string {
  let value = '';
  for (const byte of data) value += String.fromCharCode(byte);
  return btoa(value);
}
function bytes(value: string, max = 4 * 1024 * 1024): ArrayBuffer {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return failure('密钥备份编码不正确');
  try { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)).buffer; }
  catch { return failure('密钥备份编码不正确'); }
}
function checkPassphrase(passphrase: string) {
  if (typeof passphrase !== 'string' || Array.from(passphrase).length < 8 || passphrase.length > 1024) return failure('备份口令至少 8 个字符，且不超过 1024 个字符');
}
async function key(passphrase: string, salt: ArrayBuffer, iterations: number) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function validateSecrets(value: unknown): Record<string, Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 256) return failure('密钥备份内容不正确');
  const result: Record<string, Record<string, string>> = {};
  for (const [id, fields] of Object.entries(value)) {
    if (!/^[\w.:-]{1,128}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)
      || !fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > 128) return failure('密钥备份服务信息不正确');
    const clean: Record<string, string> = {};
    for (const [name, field] of Object.entries(fields)) {
      if (!/^[\w.:-]{1,128}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)
        || typeof field !== 'string' || field.length > 65536) return failure('密钥备份字段不正确');
      clean[name] = field;
    }
    result[id] = clean;
  }
  return result;
}

export async function encryptSecrets(secrets: Record<string, Record<string, string>>, passphrase: string): Promise<EncryptedSecrets> {
  checkPassphrase(passphrase);
  const plain = new TextEncoder().encode(JSON.stringify(validateSecrets(secrets)));
  if (plain.byteLength > 2 * 1024 * 1024) return failure('密钥备份超过 2MB 上限');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await key(passphrase, salt.buffer, ITERATIONS), plain);
  return { version: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: base64(salt), iv: base64(iv), ciphertext: base64(new Uint8Array(cipher)) };
}

export async function decryptSecrets(value: unknown, passphrase: string): Promise<Record<string, Record<string, string>>> {
  checkPassphrase(passphrase);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failure('密钥备份格式不正确');
  const envelope = value as EncryptedSecrets;
  if (envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256' || !Number.isSafeInteger(envelope.iterations)
    || envelope.iterations < 100_000 || envelope.iterations > 1_000_000) return failure('不支持的密钥备份版本或派生参数');
  const salt = bytes(envelope.salt, 128), iv = bytes(envelope.iv, 128), cipher = bytes(envelope.ciphertext);
  if (salt.byteLength !== 16 || iv.byteLength !== 12 || cipher.byteLength < 16) return failure('密钥备份参数不正确');
  let decoded: unknown;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await key(passphrase, salt, envelope.iterations), cipher);
    decoded = JSON.parse(new TextDecoder().decode(plain));
  } catch { return failure('口令不正确或密钥备份已损坏'); }
  return validateSecrets(decoded);
}

export async function exportVault(vault: Pick<SecretVault, 'get'>, passphrase: string, ids: string[]): Promise<EncryptedSecrets> {
  if (!Array.isArray(ids) || ids.length > 256 || new Set(ids).size !== ids.length) return failure('需要导出的服务列表不正确');
  const result: Record<string, Record<string, string>> = {};
  for (const id of ids) { validateSecrets({ [id]: {} }); result[id] = await vault.get(id); }
  return encryptSecrets(result, passphrase);
}

export async function importVault(vault: Pick<SecretVault, 'get' | 'set'>, archive: unknown, passphrase: string, allowedIds?: string[]): Promise<string[]> {
  // 完整认证并校验后才开始写，口令错误或坏数据不会更改任何服务。
  const secrets = await decryptSecrets(archive, passphrase);
  if (allowedIds && Object.keys(secrets).some((id) => !allowedIds.includes(id))) return failure('归档包含不允许导入的服务');
  const previous: Record<string, Record<string, string>> = {};
  const written: string[] = [];
  for (const id of Object.keys(secrets)) previous[id] = await vault.get(id);
  try {
    for (const [id, value] of Object.entries(secrets)) { await vault.set(id, value); written.push(id); }
  } catch (error) {
    for (const id of written.reverse()) { try { await vault.set(id, previous[id]!); } catch { /* 原始保存失败仍必须向调用方报告 */ } }
    throw error;
  }
  return Object.keys(secrets);
}
