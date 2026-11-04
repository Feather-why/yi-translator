/**
 * 图表配色与数字格式，悬浮球小窗和设置页的服务状态共用，保证同一家服务在两处颜色一致。
 * 分类色按固定顺序分配，颜色跟着服务走（按 id 排序），不跟排名走；超过 8 家归入「其他」。
 */
import type { ProviderStatus, QuotaInfo } from '../../shared/protocol';
import { L, uiLang } from '../i18n';

/** 分类色已并入 ../theme.ts 的设计变量（--s1…--s8、--other），这里只负责分配。 */
export function seriesColors(providers: ProviderStatus[]): Map<string, string> {
  const ids = providers.filter((p) => p.quota).map((p) => p.id).sort();
  return new Map(ids.map((id, i) => [id, i < 8 ? `var(--s${i + 1})` : 'var(--other)']));
}

/** 日额度按 30 天折算成月，便于不同周期的服务放在一起比较。 */
export function monthly(q: QuotaInfo): number {
  return q.period === 'day' ? q.amount * 30 : q.amount;
}

export function wan(n: number): string {
  if (uiLang() === 'en') return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.round(n));
  if (n >= 1e8) return (n / 1e8).toFixed(n >= 1e9 ? 0 : 1).replace(/\.0$/, '') + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + ' 万';
  return Math.round(n).toLocaleString('zh-CN');
}

export const UNIT_LABEL: Record<QuotaInfo['unit'], string> = {
  get char() { return L('字符', 'chars'); },
  token: 'token',
  get request() { return L('次', 'requests'); },
};
export const PERIOD_LABEL: Record<QuotaInfo['period'], string> = {
  get day() { return L('日', 'day'); },
  get month() { return L('月', 'month'); },
  get cycle() { return L('周期', 'cycle'); },
};
