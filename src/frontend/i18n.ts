/**
 * 扩展界面的语言（只有中文和英文两套）。写法：L('中文', 'English')，中英文放在一起，改的时候不会漏。
 * 'auto' 跟浏览器的界面语言：zh* 用中文，其他用英文。
 * 读到设置后调用 setUiLang()；在那之前（模块顶层）按浏览器语言算。顶层的标签表请用 getter 或 onUiLang 重算。
 */
export type UiLang = 'zh' | 'en';
export type UiLangPref = 'auto' | 'zh-CN' | 'en';

function resolve(pref: UiLangPref | undefined): UiLang {
  if (pref === 'zh-CN') return 'zh';
  if (pref === 'en') return 'en';
  const nav = typeof navigator === 'undefined' ? 'zh-CN' : navigator.languages?.[0] ?? navigator.language ?? 'zh-CN';
  return /^zh\b/i.test(nav) ? 'zh' : 'en';
}

let lang: UiLang = resolve('auto');
const listeners = new Set<(l: UiLang) => void>();

export function setUiLang(pref: UiLangPref | undefined): void {
  const next = resolve(pref);
  if (next === lang) return;
  lang = next;
  for (const fn of listeners) fn(lang);
}

export const uiLang = (): UiLang => lang;

/** 界面语言变了时（读到设置后）重算顶层的标签。注册时立即调用一次。 */
export function onUiLang(fn: (l: UiLang) => void): void {
  listeners.add(fn);
  fn(lang);
}

export const L = (zh: string, en: string): string => (lang === 'en' ? en : zh);
