/**
 * 紧凑的语言选择：看起来是一小段文字（「自动」「English」），点开是原生下拉框。
 * 原生 <select> 的宽度由最长的选项决定，小窗里放不下，所以把透明的 select 叠在文字上面。
 */
import { shortLang } from '../langs';
import { h } from './host';

export const LANG_PICKER_CSS = `
.lp { position: relative; display: inline-flex; align-items: center; gap: 2px; padding: 2px 5px; border-radius: 6px; color: var(--ink-2); cursor: pointer; white-space: nowrap; }
.lp:hover, .lp:focus-within { background: var(--hover); color: var(--ink); }
.lp::after { content: ""; width: 0; height: 0; border-left: 3px solid transparent; border-right: 3px solid transparent; border-top: 4px solid currentColor; opacity: .5; margin-left: 2px; }
.lp select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; font: inherit; border: 0; }
`;

export interface LangPicker {
  el: HTMLLabelElement;
  select: HTMLSelectElement;
  set(value: string): void;
}

export function langPicker(list: [string, string][], value: string, title: string, onChange: (v: string) => void): LangPicker {
  const text = h('span', { class: 'v' });
  const select = h('select', { title, 'aria-label': title }) as HTMLSelectElement;
  for (const [v, label] of list) select.append(h('option', { value: v }, label));
  const el = h('label', { class: 'lp', title }, text, select) as HTMLLabelElement;
  const set = (v: string) => {
    if (![...select.options].some((o) => o.value === v)) select.append(h('option', { value: v }, v));
    select.value = v;
    text.textContent = shortLang(v);
  };
  set(value);
  select.addEventListener('change', () => {
    text.textContent = shortLang(select.value);
    onChange(select.value);
  });
  return { el, select, set };
}
