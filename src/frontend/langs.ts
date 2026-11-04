/**
 * 界面里能选的语言。代码用 BCP-47，后端和各家服务自己做映射。
 * 名字用这门语言自己的写法，后面括号里是中文，方便在下拉框里认。
 */
import { L, onUiLang } from './i18n';

/** [代码, 本语言写法, 中文名, 英文名] */
const TABLE: [string, string, string, string][] = [
  ['zh-CN', '简体中文', '', 'Chinese, Simplified'],
  ['zh-TW', '繁體中文', '', 'Chinese, Traditional'],
  ['en', 'English', '英语', ''],
  ['ja', '日本語', '日语', 'Japanese'],
  ['ko', '한국어', '韩语', 'Korean'],
  ['fr', 'Français', '法语', 'French'],
  ['de', 'Deutsch', '德语', 'German'],
  ['es', 'Español', '西班牙语', 'Spanish'],
  ['pt', 'Português', '葡萄牙语', 'Portuguese'],
  ['it', 'Italiano', '意大利语', 'Italian'],
  ['ru', 'Русский', '俄语', 'Russian'],
  ['sv', 'Svenska', '瑞典语', 'Swedish'],
  ['nl', 'Nederlands', '荷兰语', 'Dutch'],
  ['pl', 'Polski', '波兰语', 'Polish'],
  ['tr', 'Türkçe', '土耳其语', 'Turkish'],
  ['uk', 'Українська', '乌克兰语', 'Ukrainian'],
  ['vi', 'Tiếng Việt', '越南语', 'Vietnamese'],
  ['th', 'ไทย', '泰语', 'Thai'],
  ['id', 'Bahasa Indonesia', '印尼语', 'Indonesian'],
  ['ar', 'العربية', '阿拉伯语', 'Arabic'],
];

/**
 * 界面里能选的语言：[代码, 显示名]。名字用这门语言自己的写法，括号里是界面语言（中文 / 英文）的名字，方便在下拉框里认。
 * 界面语言变了时原地更新（别的模块拿着同一个数组）。
 */
export const LANGS: [code: string, label: string][] = [];
/** 原文语言多一个「自动识别」。 */
export const SOURCE_LANGS: [string, string][] = [];

onUiLang((lang) => {
  const rows = TABLE.map(([code, native, zh, en]): [string, string] => {
    const local = lang === 'en' ? en : zh;
    return [code, !local ? native : lang === 'en' ? `${native} (${local})` : `${native}（${local}）`];
  });
  LANGS.splice(0, LANGS.length, ...rows);
  SOURCE_LANGS.splice(0, SOURCE_LANGS.length, ['auto', L('自动识别', 'Detect language')], ...rows);
});

/** 下拉框里显示的短名字（小窗、输入框小球里地方小）。 */
export function shortLang(code: string): string {
  if (code === 'auto') return L('自动', 'Auto');
  const hit = LANGS.find(([c]) => c === code);
  if (!hit) return code;
  return hit[1].replace(/\s?[（(].*[）)]$/, '');
}

export function langLabel(code: string): string {
  return SOURCE_LANGS.find(([c]) => c === code)?.[1] ?? code;
}
