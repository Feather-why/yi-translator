import { ProviderError } from '../providers/types';
import type { LwwRecord, SyncDocument, UsageCounters } from './types';

const safeKey = (value: string) => value.length > 0 && value.length <= 1024 && !['__proto__', 'prototype', 'constructor'].includes(value) && !/[\u0000-\u001f]/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function portable(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => portable(entry, depth + 1));
  if (record(value)) return Object.entries(value).every(([key, entry]) => safeKey(key) && portable(entry, depth + 1));
  return false;
}
export function validateDocument(value: unknown): SyncDocument {
  const fail = (): never => { throw new ProviderError({ code: 'bad_input', message: '同步文件结构不正确', retryable: false }); };
  if (!record(value) || value.version !== 1 || !record(value.fields) || !record(value.usage) || Object.keys(value.fields).length > 100_000) return fail();
  const fields: Record<string, LwwRecord> = {};
  for (const [key, entry] of Object.entries(value.fields)) {
    if (!safeKey(key) || !record(entry) || !Number.isSafeInteger(entry.updatedAt) || Number(entry.updatedAt) < 0
      || typeof entry.deviceId !== 'string' || !safeKey(entry.deviceId) || (entry.deleted !== undefined && typeof entry.deleted !== 'boolean')
      || (entry.deleted !== true && !Object.hasOwn(entry, 'value'))) return fail();
    // JSON 复制也拒绝函数、BigInt、循环对象等非可移植值。
    if (entry.deleted !== true && !portable(entry.value)) return fail();
    const encoded = JSON.stringify(entry.value);
    if (!entry.deleted && encoded === undefined) return fail();
    fields[key] = { updatedAt: Number(entry.updatedAt), deviceId: entry.deviceId,
      ...(entry.deleted ? { deleted: true } : { value: JSON.parse(encoded!) as unknown }) };
  }
  const usage: UsageCounters = {};
  for (const [provider, periods] of Object.entries(value.usage)) {
    if (!safeKey(provider) || !record(periods) || Object.keys(periods).length > 400) return fail();
    usage[provider] = {};
    for (const [period, devices] of Object.entries(periods)) {
      if (!safeKey(period) || !record(devices) || Object.keys(devices).length > 1000) return fail();
      const counters: Record<string, number> = {};
      for (const [device, count] of Object.entries(devices)) {
        if (!safeKey(device) || !Number.isSafeInteger(count) || Number(count) < 0) return fail();
        counters[device] = Number(count);
      }
      usage[provider]![period] = counters;
    }
  }
  return { version: 1, fields, usage };
}

export function mergeDocuments(left: SyncDocument, right: SyncDocument): SyncDocument {
  const a = validateDocument(left), b = validateDocument(right);
  const fields = { ...a.fields };
  for (const [key, incoming] of Object.entries(b.fields)) {
    const current = fields[key];
    // 同一毫秒按设备 ID 决胜，再按值决胜，确保交换两台设备的合并方向仍收敛。
    if (!current || incoming.updatedAt > current.updatedAt || (incoming.updatedAt === current.updatedAt &&
      (incoming.deviceId > current.deviceId || (incoming.deviceId === current.deviceId && JSON.stringify(incoming) > JSON.stringify(current))))) fields[key] = incoming;
  }
  const usage = structuredClone(a.usage);
  for (const [provider, periods] of Object.entries(b.usage)) {
    const out = usage[provider] ??= {};
    for (const [period, devices] of Object.entries(periods)) {
      const counts = out[period] ??= {};
      // 每台设备的单调计数取 max；设备之间求和时不会把一次同步重复计费。
      for (const [device, count] of Object.entries(devices)) counts[device] = Math.max(counts[device] ?? 0, count);
    }
  }
  // 保留最新 400 个周期，防止日计数经多年同步后无限增大。
  for (const periods of Object.values(usage)) {
    const keys = Object.keys(periods).sort((a, b) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Number(b) - Number(a) : b.localeCompare(a));
    for (const key of keys.slice(400)) delete periods[key];
  }
  return { version: 1, fields, usage };
}
