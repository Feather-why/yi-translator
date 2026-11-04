/**
 * 设置的存储约定。
 *
 * 两份设置分别存在 chrome.storage.local 的两个键里，谁的键谁写，另一方只读：
 * - 'settings.ui'   前端（Claude）负责：显示方式、颜色、悬浮球、站点名单……
 * - 'settings.core' 后端（GPT）负责：调度策略、本地/远程模型、同步……
 *
 * API key 等密钥不放在这里，由后端自己存（见 ProviderInfo / providers:save）。
 */
import type { LangCode, Mode } from './protocol';

export const UI_SETTINGS_KEY = 'settings.ui';
export const CORE_SETTINGS_KEY = 'settings.core';

export type DisplayMode = 'bilingual' | 'translation' | 'original';
export type BilingualStyle = 'paragraph' | 'sentence';
/** 等待译文时的效果：字符跳动后定格，或静态省略号。 */
export type LoadingEffect = 'scramble' | 'dots';
/** 译文样式预设：默认浅色、左侧竖线、淡底色块、虚线下划线、学习模式（先模糊，鼠标移上去才显示）。 */
export type TxStyle = 'plain' | 'bar' | 'tint' | 'underline' | 'blur';
/** 悬浮球和小窗的深浅色：跟随网页背景、固定浅色、固定深色。 */
export type UiTheme = 'auto' | 'light' | 'dark';

/** 输入框翻译的快捷键（在网页的输入框里按）。 */
export type InputShortcut = 'Alt+T' | 'Alt+Y' | 'Ctrl+Shift+Y' | 'off';

export interface UiSettings {
  version: 1;
  /** 原文语言：'auto' 自动识别（默认）；认不准时（如很短的瑞典语）可以手动指定。 */
  sourceLang: LangCode;
  targetLang: LangCode;
  mode: Mode;
  display: DisplayMode;
  bilingualStyle: BilingualStyle;
  /** 译文字号相对原文的比例，0.85~1。 */
  fontScale: number;
  /** 综合模式下高速译文的颜色浓度（相对原文颜色的百分比）。 */
  fastColorPercent: number;
  /** 精确译文的颜色浓度。 */
  finalColorPercent: number;
  /** 旧版的「译文左侧细竖线」开关，已并入 txStyle: 'bar'（读取时自动迁移）。 */
  accentBar: boolean;
  txStyle: TxStyle;
  theme: UiTheme;
  /** 个性化外观：主题色、悬浮球的样子。 */
  appearance: {
    /** 预设 id（mist / slate / pine / dusk / ochre / rose / graphite）或 #rrggbb。 */
    accent: string;
    /** 悬浮球：浅色底 + 主题色标志 / 主题色实心 / 半透明毛玻璃。 */
    ball: 'light' | 'accent' | 'glass';
    ballSize: 's' | 'm' | 'l';
    /** 不用的时候悬浮球的不透明度 0.35~1（鼠标移上去恢复）。 */
    idleOpacity: number;
  };
  loadingEffect: LoadingEffect;
  ball: {
    side: 'left' | 'right';
    /** 距离视口顶部的比例 0~1。 */
    y: number;
    /** 在这些站点隐藏悬浮球（hostname）。 */
    hiddenOn: string[];
  };
  selection: {
    enabled: boolean;
    /** 输入框、可编辑区域里是否也弹出。 */
    inEditable: boolean;
    /** 划词翻译默认用的模式。 */
    mode: Mode;
  };
  /**
   * 输入框翻译（反向翻译）：在网页的输入框里写好母语，一键翻成要发出去的语言。
   * 划词时如果选中的已经是目标语言，也翻成这里的语言。
   */
  input: {
    enabled: boolean;
    /** 翻成什么语言，默认英语。 */
    targetLang: LangCode;
    mode: Mode;
    /** 输入框右下角的小圆球。 */
    ball: boolean;
    shortcut: InputShortcut;
    /** 连按三下空格触发。 */
    tripleSpace: boolean;
    /** 在这些站点不显示输入框小球（快捷键照常可用）。 */
    hiddenOn: string[];
  };
  sites: {
    /** 打开就自动翻译的站点（hostname）。 */
    always: string[];
    /** 永不翻译的站点。 */
    never: string[];
  };
  /** 敏感网站：不自动翻译、不写缓存（通配符匹配 hostname）。 */
  sensitive: string[];
  /** 整页翻译时是否也自动翻译图片里的文字（本地 OCR）。不开也可以把鼠标移到图片上手动翻译。 */
  imageTranslate: boolean;
  /** 图片上是否显示「翻译这张图」的小按钮。 */
  imageButton: boolean;
  /** 只翻正文：自动认出文章主体，跳过导航、侧栏、页脚、评论区。站点规则写了 include 时以规则为准。 */
  mainOnly: boolean;
  /** 是否已经走完首次使用引导。 */
  onboarded: boolean;
  /** 扩展自己的界面语言（悬浮球、小窗、PDF 阅读器、设置页）。'auto' 跟浏览器：中文浏览器用中文，其他用英文。 */
  uiLang: 'auto' | 'zh-CN' | 'en';
  /** YouTube 双语字幕。 */
  subtitles: {
    enabled: boolean;
    display: 'bilingual' | 'translation';
    /** 字号倍数（相对播放器高度自动算出的字号），0.6~1.8。 */
    fontScale: number;
    /** 字幕背景的不透明度 0~1。 */
    bgOpacity: number;
    /** 译文在上还是原文在上。 */
    order: 'tr-first' | 'src-first';
    /** 拖动后的位置：距播放器底部的比例 0~0.9；null 为自动（避开控制条）。 */
    offsetY: number | null;
    /** 双语字幕稿侧栏是否打开。 */
    panel: boolean;
  };
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  version: 1,
  sourceLang: 'auto',
  targetLang: 'zh-CN',
  mode: 'combined',
  display: 'bilingual',
  bilingualStyle: 'paragraph',
  fontScale: 1,
  fastColorPercent: 55,
  finalColorPercent: 90,
  accentBar: false,
  txStyle: 'plain',
  theme: 'auto',
  appearance: { accent: 'mist', ball: 'light', ballSize: 'm', idleOpacity: 1 },
  loadingEffect: 'scramble',
  ball: { side: 'right', y: 0.62, hiddenOn: [] },
  selection: { enabled: true, inEditable: false, mode: 'accurate' },
  input: { enabled: true, targetLang: 'en', mode: 'accurate', ball: true, shortcut: 'Alt+T', tripleSpace: false, hiddenOn: [] },
  sites: { always: [], never: [] },
  sensitive: [
    '*.bank*',
    '*bank.*',
    'mail.google.com',
    'outlook.live.com',
    'outlook.office.com',
    'localhost',
    '127.0.0.1',
    '*.local',
    '*.internal',
  ],
  imageTranslate: false,
  imageButton: true,
  mainOnly: true,
  onboarded: false,
  uiLang: 'auto',
  subtitles: { enabled: true, display: 'bilingual', fontScale: 1, bgOpacity: 0.72, order: 'tr-first', offsetY: null, panel: false },
};

/**
 * 后端设置。这里只列出前端会读的字段；后端可以继续扩展，
 * 但不要改动已有字段的含义。
 */
export interface CoreSettings {
  version: 1;
  /** 是否允许使用非官方的免 key 接口（默认 false）。 */
  allowUnofficial: boolean;
  /** 笔记本本地 llama-server 地址，如 http://127.0.0.1:8081 */
  localModelUrl?: string;
  remoteNodes: { id: string; name: string; url: string }[];
  sync?: { enabled: boolean; url?: string; lastSyncAt?: number };
}

export const DEFAULT_CORE_SETTINGS: CoreSettings = {
  version: 1,
  allowUnofficial: false,
  remoteNodes: [],
};

function merge<T>(defaults: T, stored: unknown): T {
  if (!stored || typeof stored !== 'object') return structuredClone(defaults);
  const out: any = structuredClone(defaults);
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = { ...out[k], ...v };
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export async function loadUiSettings(): Promise<UiSettings> {
  const got: Record<string, unknown> = await chrome.storage.local.get(UI_SETTINGS_KEY);
  const raw = got[UI_SETTINGS_KEY];
  const s = merge(DEFAULT_UI_SETTINGS, raw);
  // 旧版只有 accentBar 开关：迁移成「左侧竖线」样式
  if (raw && typeof raw === 'object' && (raw as Partial<UiSettings>).accentBar && !(raw as Partial<UiSettings>).txStyle) s.txStyle = 'bar';
  return s;
}

/** 只有前端调用。 */
export async function saveUiSettings(patch: Partial<UiSettings>): Promise<UiSettings> {
  const cur = await loadUiSettings();
  const next = merge(cur, patch);
  await chrome.storage.local.set({ [UI_SETTINGS_KEY]: next });
  return next;
}

export async function loadCoreSettings(): Promise<CoreSettings> {
  const got = await chrome.storage.local.get(CORE_SETTINGS_KEY);
  return merge(DEFAULT_CORE_SETTINGS, got[CORE_SETTINGS_KEY]);
}

export function onUiSettingsChanged(cb: (s: UiSettings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[UI_SETTINGS_KEY]) {
      cb(merge(DEFAULT_UI_SETTINGS, changes[UI_SETTINGS_KEY].newValue));
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** 通配符匹配 hostname：'*.bank*' 之类。 */
export function hostMatches(host: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    return re.test(host);
  });
}
