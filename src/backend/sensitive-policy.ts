import { loadUiSettings, UI_SETTINGS_KEY } from '../shared/settings';

interface Policy {
  area: typeof chrome.storage.local;
  events: typeof chrome.storage.onChanged;
  generation: number;
  disposed?: boolean;
  patterns?: string[];
  pending?: Promise<string[]>;
  changed(changes: Record<string, chrome.storage.StorageChange>, area: string): void;
}
let current: Policy | undefined;

export function disposeSensitivePolicy() {
  if (current) { current.generation++; current.disposed = true; current.events.removeListener(current.changed); }
  current = undefined;
}

/** 只缓存敏感域名规则，不缓存网页地址或正文；规则变化后旧读取也不能再提交。 */
export async function sensitivePatterns(): Promise<string[]> {
  const area = chrome.storage.local, events = chrome.storage.onChanged;
  if (!events?.addListener) return checked((await loadUiSettings()).sensitive);
  if (!current || current.area !== area || current.events !== events) {
    disposeSensitivePolicy();
    const policy: Policy = { area, events, generation: 0, changed: (changes, name) => {
      if (name === 'local' && Object.hasOwn(changes, UI_SETTINGS_KEY)) {
        policy.generation++; policy.patterns = undefined; policy.pending = undefined;
      }
    } };
    current = policy; events.addListener(policy.changed);
  }
  const policy = current;
  if (policy.patterns) return policy.patterns;
  if (policy.pending) return policy.pending;
  const generation = policy.generation;
  const pending = loadUiSettings().then((settings) => {
    if (policy.disposed) throw new Error('敏感规则读取已结束');
    if (current !== policy || policy.generation !== generation) return sensitivePatterns();
    policy.patterns = checked(settings.sensitive); return policy.patterns;
  }).finally(() => { if (policy.pending === pending) policy.pending = undefined; });
  policy.pending = pending; return pending;
}

function checked(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error('敏感站点规则不可读取');
  return value.slice();
}
