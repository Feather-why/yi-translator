/**
 * 临时的假后端：按 src/shared/protocol.ts 实现全部端口和 RPC，返回「看起来像中文」的假译文。
 * 只为了在真后端完成之前开发和测试前端。GPT 实现 src/backend/ 后，background.ts 不再引用这里。
 *
 * - 高速结果约 150ms 到，精确结果约 800ms 到，用来检查综合模式的浅→深覆盖；
 * - 占位符原样保留（只改占位符之间的文字）；
 * - 状态快照、服务列表都是示例数据。
 */
import {
  PORT_STATUS,
  PORT_TRANSLATE,
  type AlignResult,
  type DictEntry,
  type ProviderInfo,
  type SiteRule,
  type ProviderOptions,
  type ProviderTemplate,
  type StatusSnapshot,
  type TranslateClientMsg,
  type TranslateServerMsg,
} from '../shared/protocol';
import type { RuleSubscriptionInfo } from '../shared/backend-v2';
import { onRpc, RpcError } from '../shared/rpc';

const POOL =
  '的一是在不了有和人这中大为上个我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经之进着等部度家电力里如水化高自理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系很情者最立代想已通并提直题程展五果料象员位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别手角期根论运指几九区强放决西被干做必战先回则任取据处';

const WORDS: Record<string, string> = {
  the: '', a: '一个', an: '一个', and: '和', or: '或', of: '的', to: '到', in: '在', is: '是', are: '是', for: '为',
  with: '与', this: '这', that: '那', it: '它', you: '你', we: '我们', they: '他们', on: '在', by: '由', from: '从',
  translation: '翻译', translate: '翻译', page: '页面', browser: '浏览器', extension: '扩展', fast: '快速', model: '模型',
  local: '本地', quality: '质量', text: '文本', link: '链接', links: '链接', example: '示例', paragraph: '段落',
  sentence: '句子', word: '词', language: '语言', open: '开源', source: '源', free: '免费', speed: '速度', test: '测试',
  web: '网页', read: '阅读', more: '更多', new: '新', first: '第一', can: '可以', will: '将', not: '不', all: '所有',
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function pseudoWord(w: string, salt: string): string {
  const n = 1 + (w.length > 5 ? 1 : 0) + (w.length > 9 ? 1 : 0);
  let out = '';
  for (let i = 0; i < n; i++) out += POOL[hash(salt + w.toLowerCase() + i) % POOL.length];
  return out;
}

const PUNCT: Record<string, string> = { '.': '。', ',': '，', '?': '？', '!': '！', ':': '：', ';': '；', '(': '（', ')': '）' };
const TOKEN_RE = /(<\/?[gx]\d+\/?>)/;

export function pseudoTranslate(text: string, stage: 'fast' | 'final'): string {
  return text
    .split(TOKEN_RE)
    .map((part) => {
      if (TOKEN_RE.test(part)) return part;
      return part
        .replace(/[\p{L}][\p{L}'’]*/gu, (w) => {
          if (/\p{Script=Han}/u.test(w)) return w;
          // 公式里的 Unicode 数学字母（𝑁、𝐱）：真的翻译服务会原样保留
          if (/[\u{1D400}-\u{1D7FF}]/u.test(w)) return w;
          const known = WORDS[w.toLowerCase()];
          if (stage === 'final' && known !== undefined) return known;
          return pseudoWord(w, stage === 'fast' ? 'q' : 'f');
        })
        .replace(/(?<=[\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, '')
        .replace(/[.,?!:;()](?=\s|$)/g, (p) => PUNCT[p] ?? p)
        .replace(/(?<=[，。？！：；])\s+/g, '');
    })
    .join('');
}

/* ------------------------------------------------------------------ */

const RULES: SiteRule[] = [{ id: 'builtin-1', match: ['*.wikipedia.org'], include: ['#mw-content-text'], exclude: ['.reference', '.mw-editsection'], source: 'builtin' }];
const SUBS: RuleSubscriptionInfo[] = [{ url: 'https://rules.example/list.json', version: 'release-2026.11', updatedAt: Date.UTC(2026, 10, 3, 8), count: 12, canRollback: true, lastError: '规则更新失败，继续使用上次有效规则' }];
const SYNC: { enabled: boolean; lastSyncAt?: number; lastError?: string } = { enabled: false };

/** 假后端里被置顶的服务（悬浮球小窗「引擎」选择就是置顶 / 取消置顶）。 */
const PINNED = new Set<string>();

function sampleStatus(): StatusSnapshot {
  const now = Date.now();
  const month = new Date();
  month.setMonth(month.getMonth() + 1, 1);
  month.setHours(0, 0, 0, 0);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const jitter = (x: number) => Math.round(x * (0.9 + Math.random() * 0.2));
  return {
    at: now,
    providers: ([
      { id: 'llamacpp-local', name: '本地 Hy-MT2-1.8B', kind: 'local', official: true, enabled: true, configured: true, health: 'ok', active: true, rank: 1, latencyP50Ms: jitter(180), successRate: 0.998, adapter: { file: 'src/backend/providers/llamacpp.ts', version: '1.0.0' }, usedFor: ['fast', 'combined'] },
      { id: 'microsoft', name: '微软翻译', kind: 'mt', official: true, enabled: true, configured: true, health: 'ok', active: true, rank: 2, latencyP50Ms: jitter(240), successRate: 0.995, quota: { unit: 'char', amount: 2_000_000, used: 640_000, period: 'month', resetAt: month.getTime() }, adapter: { file: 'src/backend/providers/microsoft.ts', version: '1.0.0' }, usedFor: ['fast', 'combined'] },
      { id: 'tencent', name: '腾讯翻译君', kind: 'mt', official: true, enabled: false, configured: false, health: 'unconfigured', active: false, rank: null, adapter: { file: 'src/backend/providers/tencent.ts', version: '1.0.0' }, usedFor: ['fast', 'combined'] },
      { id: 'niutrans', name: '小牛翻译', kind: 'mt', official: true, enabled: true, configured: true, health: 'degraded', active: false, rank: 3, latencyP50Ms: jitter(520), successRate: 0.93, quota: { unit: 'char', amount: 200_000, used: 151_000, period: 'day', resetAt: tomorrow.getTime() }, lastError: { code: 'rate_limit', message: '请求过快，已限流', at: now - 90_000 }, adapter: { file: 'src/backend/providers/niutrans.ts', version: '1.0.0' }, usedFor: ['fast'] },
      { id: 'deepl-free', name: 'DeepL Free', kind: 'mt', official: true, enabled: true, configured: true, health: 'exhausted', active: false, rank: null, latencyP50Ms: 380, successRate: 0.99, quota: { unit: 'char', amount: 500_000, used: 500_000, period: 'month', resetAt: month.getTime() }, lastError: { code: 'quota', message: '本月额度已用完', at: now - 3_600_000 }, adapter: { file: 'src/backend/providers/deepl.ts', version: '1.0.0' }, usedFor: ['fast', 'combined'] },
      { id: 'remote-7b', name: '台式机 Hy-MT2-7B', kind: 'remote', official: true, enabled: true, configured: true, health: 'ok', active: true, rank: 1, latencyP50Ms: jitter(650), successRate: 0.997, adapter: { file: 'src/backend/providers/remote-node.ts', version: '1.0.0' }, usedFor: ['accurate', 'combined'] },
      { id: 'gemini', name: 'Gemini Flash', kind: 'llm', official: true, enabled: true, configured: true, health: 'ok', active: false, rank: 2, latencyP50Ms: jitter(900), successRate: 0.98, quota: { unit: 'request', amount: 1500, used: 212, period: 'day', resetAt: tomorrow.getTime() }, adapter: { file: 'src/backend/providers/gemini.ts', version: '1.0.0' }, usedFor: ['accurate', 'combined'] },
      { id: 'chrome-builtin', name: 'Chrome 本地翻译', kind: 'builtin', official: true, enabled: true, configured: true, health: 'ok', active: false, rank: 4, latencyP50Ms: jitter(90), successRate: 1, adapter: { file: 'src/backend/providers/chrome-builtin.ts', version: '1.0.0' }, usedFor: ['fast'] },
      { id: 'baidu', name: '百度翻译', kind: 'mt', official: true, enabled: false, configured: false, health: 'unconfigured', active: false, rank: null, adapter: { file: 'src/backend/providers/baidu.ts', version: '1.0.0' }, usedFor: ['fast'] },
      { id: 'google-web', name: '谷歌网页（非官方）', kind: 'mt', official: false, enabled: false, configured: true, health: 'disabled', active: false, rank: null, adapter: { file: 'src/backend/providers/unofficial/google-web.ts', version: '0.9.0' }, usedFor: ['fast'] },
    ] as StatusSnapshot['providers']).map((p) => ({ ...p, pinned: PINNED.has(p.id) })),
    nodes: [
      { id: 'laptop', name: '本机（RTX 5070 Ti Laptop）', location: 'local', online: true, models: [{ id: 'Hy-MT2-1.8B-Q4_K_M', loaded: true, vramMB: 1480 }], queue: 0, tokensPerSec: jitter(160) },
      { id: 'desktop', name: '台式机（Tailscale）', location: 'remote', online: true, models: [{ id: 'Hy-MT2-7B-Q4_K_M', loaded: true, vramMB: 5600 }, { id: 'awesome-align', loaded: true, vramMB: 0 }], queue: 2, tokensPerSec: jitter(85) },
    ],
    events: [
      { at: now - 90_000, level: 'warn', message: '小牛翻译限流，权重临时下调', providerId: 'niutrans' },
      { at: now - 3_600_000, level: 'error', message: 'DeepL Free 本月额度已用完，已切换到微软', providerId: 'deepl-free' },
      { at: now - 7_200_000, level: 'info', message: '台式机节点上线，精确模式改用 Hy-MT2-7B' },
    ],
    perf: { firstScreenMsP50: 420, samples: 37 },
    sync: { lastSyncAt: now - 600_000 },
  };
}

const MT_EDIT: (keyof ProviderOptions)[] = ['endpoint', 'timeoutMs', 'usedFor', 'weight', 'concurrency', 'qps', 'maxChars', 'quota'];
const LLM_EDIT: (keyof ProviderOptions)[] = ['endpoint', 'model', 'timeoutMs', 'usedFor', 'weight', 'concurrency', 'maxChars', 'quota', 'prompt', 'temperature'];
const LOCAL_EDIT: (keyof ProviderOptions)[] = ['endpoint', 'model', 'timeoutMs', 'usedFor', 'weight', 'concurrency', 'maxChars', 'prompt', 'temperature'];
const DEFAULT_PROMPT = '把下面的文本从 {{from}} 翻译成 {{to}}。只输出译文；原样保留 <g0></g0>、<x0/> 这类标记。\n\n{{text}}';

const PROVIDERS: ProviderInfo[] = [
  { id: 'microsoft', name: '微软翻译', kind: 'mt', official: true, enabled: true, configured: true, quotaText: '200 万字符/月（以官网为准）', usedFor: ['fast', 'combined'], adapter: { file: 'src/backend/providers/microsoft.ts', version: '1.0.0' }, docsUrl: 'https://learn.microsoft.com/azure/ai-services/translator/', config: { key: '••••', region: 'eastasia' }, auth: [
    { key: 'key', label: 'Key', secret: true, required: true },
    { key: 'region', label: 'Region', placeholder: 'eastasia' },
  ], editable: MT_EDIT, options: {}, defaults: { endpoint: 'https://api.cognitive.microsofttranslator.com', timeoutMs: 8000, usedFor: ['fast', 'combined'], weight: 50, concurrency: 4, qps: 10, maxChars: 5000, quota: { amount: 2_000_000, unit: 'char', period: 'month' } } },
  { id: 'deepl-free', name: 'DeepL Free', kind: 'mt', official: true, enabled: true, configured: true, quotaText: '50 万字符/月（以官网为准）', usedFor: ['fast', 'combined'], adapter: { file: 'src/backend/providers/deepl.ts', version: '1.0.0' }, docsUrl: 'https://developers.deepl.com/docs', config: { key: '••••' }, auth: [
    { key: 'key', label: 'Auth Key', secret: true, required: true },
  ], editable: MT_EDIT, options: { weight: 70 }, defaults: { endpoint: 'https://api-free.deepl.com', timeoutMs: 8000, usedFor: ['fast', 'combined'], weight: 50, concurrency: 2, qps: 5, maxChars: 5000, quota: { amount: 500_000, unit: 'char', period: 'month' } } },
  { id: 'niutrans', name: '小牛翻译', kind: 'mt', official: true, enabled: true, configured: true, quotaText: '20 万字符/天', usedFor: ['fast'], adapter: { file: 'src/backend/providers/niutrans.ts', version: '1.0.0' }, config: { apikey: '••••' }, auth: [
    { key: 'apikey', label: 'API Key', secret: true, required: true, helpUrl: 'https://niutrans.com/' },
  ], editable: MT_EDIT, options: {}, defaults: { endpoint: 'https://api.niutrans.com/NiuTransServer/translation', timeoutMs: 8000, usedFor: ['fast', 'combined'], weight: 50, concurrency: 2, qps: 5, maxChars: 5000, quota: { amount: 200_000, unit: 'char', period: 'day' } } },
  { id: 'llamacpp-local', name: '本地模型（llama-server）', kind: 'local', official: true, enabled: true, configured: true, usedFor: ['fast', 'combined'], adapter: { file: 'src/backend/providers/llamacpp.ts', version: '1.0.1' }, config: {}, auth: [], editable: LOCAL_EDIT, options: {}, defaults: { endpoint: 'http://127.0.0.1:8081', model: 'Hy-MT2-1.8B-Q4_K_M', timeoutMs: 15000, usedFor: ['fast', 'combined'], weight: 60, concurrency: 2, maxChars: 2000, prompt: DEFAULT_PROMPT, temperature: 0.7 } },
  { id: 'remote-7b', name: '台式机 Hy-MT2-7B', kind: 'remote', official: true, enabled: true, configured: true, usedFor: ['accurate', 'combined'], adapter: { file: 'src/backend/providers/remote-node.ts', version: '1.0.0' }, config: { token: '••••' }, auth: [
    { key: 'token', label: '访问令牌', secret: true, required: true },
  ], editable: LOCAL_EDIT, options: { endpoint: 'http://desktop.tailnet:8787' }, defaults: { endpoint: '', model: 'Hy-MT2-7B-Q4_K_M', timeoutMs: 30000, usedFor: ['accurate', 'combined'], weight: 50, concurrency: 2, maxChars: 4000, prompt: DEFAULT_PROMPT, temperature: 0.7 } },
  { id: 'gemini', name: 'Gemini Flash', kind: 'llm', official: true, enabled: true, configured: true, quotaText: '每日免费请求数（以官网为准）', usedFor: ['accurate', 'combined'], adapter: { file: 'src/backend/providers/gemini.ts', version: '1.0.0' }, config: { key: '••••' }, auth: [
    { key: 'key', label: 'API Key', secret: true, required: true, helpUrl: 'https://aistudio.google.com/apikey' },
  ], editable: LLM_EDIT, options: {}, defaults: { endpoint: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-latest', timeoutMs: 20000, usedFor: ['accurate', 'combined'], weight: 50, concurrency: 2, maxChars: 4000, quota: { amount: 1500, unit: 'request', period: 'day' }, prompt: DEFAULT_PROMPT, temperature: 0.3 } },
  { id: 'tencent', name: '腾讯翻译君', kind: 'mt', official: true, enabled: false, configured: false, quotaText: '2026-10 起不再向新用户发放免费额度', usedFor: ['fast', 'combined'], adapter: { file: 'src/backend/providers/tencent.ts', version: '1.0.0' }, config: { region: 'ap-shanghai' }, auth: [
    { key: 'secretId', label: 'SecretId', required: true, helpUrl: 'https://console.cloud.tencent.com/cam/capi' },
    { key: 'secretKey', label: 'SecretKey', secret: true, required: true },
    { key: 'region', label: '地域', type: 'select', options: [{ value: 'ap-shanghai', label: '上海' }, { value: 'ap-guangzhou', label: '广州' }, { value: 'ap-singapore', label: '新加坡' }] },
  ], editable: MT_EDIT, options: {}, defaults: { endpoint: 'https://tmt.tencentcloudapi.com', timeoutMs: 8000, usedFor: ['fast', 'combined'], weight: 50, concurrency: 4, qps: 5, maxChars: 6000, quota: { amount: 0, unit: 'char', period: 'month' } } },
  { id: 'chrome-builtin', name: 'Chrome 本地翻译', kind: 'builtin', official: true, enabled: false, configured: true, usedFor: ['fast', 'combined'], adapter: { file: 'src/backend/providers/chrome-builtin.ts', version: '1.0.0' }, config: {}, auth: [], editable: ['usedFor', 'weight'], options: {}, defaults: { usedFor: ['fast', 'combined'], weight: 60 } },
  { id: 'google-web', name: '谷歌网页（非官方）', kind: 'mt', official: false, enabled: false, configured: true, usedFor: ['fast'], adapter: { file: 'src/backend/providers/unofficial/google-web.ts', version: '0.9.0' }, config: {}, auth: [], editable: ['timeoutMs', 'usedFor', 'weight', 'concurrency', 'qps'], options: {}, defaults: { timeoutMs: 6000, usedFor: ['fast', 'combined'], weight: 30, concurrency: 2, qps: 2 } },
];

const TEMPLATE_DEFAULTS: Partial<Record<ProviderTemplate, Pick<ProviderInfo, 'kind' | 'auth' | 'editable' | 'defaults' | 'usedFor'>>> = {
  'openai-compatible': { kind: 'llm', usedFor: ['accurate', 'combined'], auth: [{ key: 'key', label: 'API Key', secret: true, placeholder: '本地服务可留空' }], editable: LLM_EDIT, defaults: { endpoint: '', model: '', timeoutMs: 20000, usedFor: ['accurate', 'combined'], weight: 50, concurrency: 2, maxChars: 4000, prompt: DEFAULT_PROMPT, temperature: 0.3 } },
  llamacpp: { kind: 'local', usedFor: ['fast', 'combined'], auth: [], editable: LOCAL_EDIT, defaults: { endpoint: 'http://127.0.0.1:8082', model: '', timeoutMs: 15000, usedFor: ['fast', 'combined'], weight: 50, concurrency: 2, maxChars: 2000, prompt: DEFAULT_PROMPT, temperature: 0.7 } },
  'remote-node': { kind: 'remote', usedFor: ['accurate', 'combined'], auth: [{ key: 'token', label: '访问令牌', secret: true, required: true }], editable: LOCAL_EDIT, defaults: { endpoint: '', model: '', timeoutMs: 30000, usedFor: ['accurate', 'combined'], weight: 50, concurrency: 2, maxChars: 4000, prompt: DEFAULT_PROMPT, temperature: 0.7 } },
  libretranslate: { kind: 'mt', usedFor: ['fast', 'combined'], auth: [{ key: 'url', label: 'LibreTranslate 基础地址', type: 'url', required: true }, { key: 'key', label: 'API key', secret: true }], editable: ['timeoutMs', 'usedFor', 'weight', 'concurrency'], defaults: { timeoutMs: 10000, usedFor: ['fast', 'combined'], weight: 40, concurrency: 2 } },
};

const DICT: Record<string, DictEntry> = {
  translate: { word: 'translate', phonetic: 'trænsˈleɪt', translations: ['vt. 翻译；转化；解释', 'vi. 翻译；能被译出'], forms: { 过去式: 'translated', 现在分词: 'translating', 第三人称单数: 'translates' }, tags: ['高考', 'CET4', '考研'], collins: 4, oxford: true, source: 'ecdict' },
  model: { word: 'model', phonetic: 'ˈmɒdl', translations: ['n. 模型；模特儿；型号', 'v. 模仿；塑造'], forms: { 复数: 'models' }, tags: ['中考', 'CET4'], collins: 5, oxford: true, source: 'ecdict' },
};

/* ------------------------------------------------------------------ */

export function installMockBackend(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === PORT_TRANSLATE) handleTranslatePort(port);
    else if (port.name === PORT_STATUS) handleStatusPort(port);
  });

  onRpc({
    ping: () => ({ protocol: 1, backend: 'mock' }),
    'dict:lookup': ({ word }) => {
      const w = word.toLowerCase();
      if (DICT[w]) return DICT[w];
      if (!/^[a-z][a-z'-]*$/i.test(word)) return null;
      return { word, translations: ['（模拟释义）' + pseudoTranslate(word, 'final')], tags: ['示例'], source: 'ecdict' };
    },
    'align:get': ({ pairs }) => pairs.map(align),
    'rules:forUrl': () => null,
    explain: ({ text }) => ({ text: `（模拟）“${text}” 在这句话里的意思是……真后端会请求大模型给出解释。`, provider: 'mock' }),
    'providers:list': () => structuredClone(PROVIDERS),
    'providers:save': ({ id, enabled, config, options, name }) => {
      const p = PROVIDERS.find((x) => x.id === id);
      if (p) {
        p.enabled = enabled;
        for (const [k, v] of Object.entries(config)) {
          const secret = p.auth.find((f) => f.key === k)?.secret;
          if (secret && v === '••••') continue;
          p.config[k] = secret && v ? '••••' : v;
        }
        if (options) {
          p.options = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined && v !== '')) as ProviderOptions;
          if (options.usedFor) p.usedFor = options.usedFor;
        }
        if (name && p.custom) p.name = name;
        p.configured = p.auth.every((f) => !f.required || !!p.config[f.key]) && (!p.editable?.includes('endpoint') || !!(p.options?.endpoint || p.defaults?.endpoint));
      }
      return { ok: true as const };
    },
    'providers:add': ({ template, name }) => {
      const t = TEMPLATE_DEFAULTS[template];
      if (!t) throw new RpcError({ code: 'bad_input', message: '演示后端不支持此服务模板', retryable: false });
      const p: ProviderInfo = {
        id: `custom-${template}-${Date.now().toString(36)}`,
        name,
        official: true,
        enabled: false,
        configured: false,
        config: {},
        options: {},
        custom: true,
        template,
        adapter: { file: template === 'openai-compatible' ? 'src/backend/providers/openai-compatible.ts' : template === 'llamacpp' ? 'src/backend/providers/llamacpp.ts' : template === 'libretranslate' ? 'src/backend/providers/libretranslate.ts' : 'src/backend/providers/remote-node.ts', version: '1.0.0' },
        ...structuredClone(t),
      };
      PROVIDERS.push(p);
      return structuredClone(p);
    },
    'providers:remove': ({ id }) => {
      const i = PROVIDERS.findIndex((x) => x.id === id && x.custom);
      if (i < 0) throw new RpcError({ code: 'bad_input', message: '内置服务不能删除', retryable: false });
      PROVIDERS.splice(i, 1);
      return { ok: true as const };
    },
    'providers:models': async ({ id }) => {
      await sleep(300);
      const p = PROVIDERS.find((x) => x.id === id);
      if (p?.kind === 'local') return ['Hy-MT2-1.8B-Q4_K_M', 'Hy-MT2-1.8B-Q8_0'];
      if (p?.kind === 'remote') return ['Hy-MT2-7B-Q4_K_M', 'Hy-MT2-7B-Q6_K'];
      return ['deepseek-chat', 'Qwen/Qwen3-8B', 'THUDM/GLM-4-9B-0414', 'gemini-flash-latest'];
    },
    'providers:test': async ({ id }) => {
      await sleep(300 + Math.random() * 300);
      return id === 'baidu'
        ? { ok: false, error: { code: 'auth', message: '缺少 APP ID', provider: id, retryable: false } }
        : { ok: true, latencyMs: Math.round(150 + Math.random() * 300) };
    },
    'feedback:bad': () => ({ ok: true as const }),
    'tm:save': () => ({ ok: true as const }),
    'perf:report': (p) => {
      console.log('[mock] perf', p);
      return { ok: true as const };
    },
    'rules:list': () => structuredClone(RULES),
    'rules:save': ({ rule }) => {
      const i = RULES.findIndex((r) => r.id === rule.id);
      if (i >= 0) RULES[i] = rule;
      else RULES.push(rule);
      return { ok: true as const };
    },
    'rules:remove': ({ id }) => {
      const i = RULES.findIndex((r) => r.id === id && r.source === 'local');
      if (i >= 0) RULES.splice(i, 1);
      return { ok: true as const };
    },
    'rules:subscriptions': () => structuredClone(SUBS),
    'providers:warm': () => ({ ok: true as const }),
    'providers:templates': () => ['openai-compatible', 'llamacpp', 'remote-node', 'libretranslate'] as ProviderTemplate[],
    'local:autostart': ({ enable }) => {
      if (enable !== undefined) AUTOSTART.enabled = enable;
      return { supported: true, enabled: AUTOSTART.enabled, canStart: true };
    },
    'local:start': async () => {
      await sleep(300);
      return { ok: true };
    },
    'rules:subscribe': async ({ url }) => {
      await sleep(300);
      RULES.push({ id: 'sub-' + RULES.length, match: ['news.ycombinator.com'], exclude: ['.comhead'], source: 'subscription' });
      if (!SUBS.some((x) => x.url === url)) {
        SUBS.push({ url, version: 'sha256:' + 'ab12cd34'.repeat(8), updatedAt: Date.now(), count: 1, canRollback: false });
      }
      return { ok: true as const };
    },
    'rules:refresh': async ({ url }) => {
      await sleep(300);
      for (const x of SUBS) if (!url || x.url === url) { x.updatedAt = Date.now(); x.canRollback = true; x.version = '2026.11.03'; }
      return { ok: true as const };
    },
    'rules:rollback': async () => (await sleep(300), { ok: true as const }),
    'sync:configure': async ({ enabled }) => {
      await sleep(300);
      SYNC.enabled = enabled;
      return { ok: true as const };
    },
    'sync:run': async () => {
      await sleep(400);
      SYNC.lastSyncAt = Date.now();
      return { ok: true as const };
    },
    'secrets:export': ({ passphrase }) => ({ archive: JSON.stringify({ v: 1, mock: true, len: passphrase.length }) }),
    'secrets:import': () => ({ ok: true as const }),
    'dict:import': async ({ csv }) => (await sleep(400), { ok: true as const, entries: csv.split('\n').length - 1 }),
    'align:configure': () => ({ ok: true as const }),
    'backend:capabilities': () => ({
      protocol: 3,
      dictionary: { ready: true, entries: 2 },
      alignment: { ready: true, model: 'mock' },
      media: { ocr: true, subtitles: true, pdf: true },
      sync: { ...SYNC },
    }),
    'ocr:image': async ({ url, dataUrl, targetLang }) => {
      // 假 OCR：按图片尺寸在上、下各放一块文字
      const blob = await (await fetch((url || dataUrl)!)).blob();
      const bmp = await createImageBitmap(blob);
      const { width: w, height: h } = bmp;
      bmp.close();
      await sleep(500);
      const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0 * w, y0 * h], [x1 * w, y0 * h], [x1 * w, y1 * h], [x0 * w, y1 * h]];
      const blocks = [
        { text: 'LOCAL FIRST TRANSLATION', confidence: 0.96, box: box(0.08, 0.14, 0.92, 0.34) },
        { text: 'Fast, private and free', confidence: 0.91, box: box(0.16, 0.56, 0.84, 0.74) },
      ].map((b) => ({ ...b, translation: targetLang ? pseudoTranslate(b.text.toLowerCase(), 'final') : undefined }));
      return { width: w, height: h, blocks, engine: 'mock', model: 'mock-ocr' };
    },
    'subtitle:translate': async ({ segments }) => {
      await sleep(300);
      return { segments: segments.map((s) => ({ ...s, source: s.text, text: pseudoTranslate(s.text, 'final'), provider: 'mock' })) };
    },
    'pdf:translate': async ({ pages }) => {
      // 给测试看：扫描页 / 混合页一共识别了几次
      const got = await chrome.storage.local.get(['mock.pdfOcr', 'mock.pdfOcrPages']);
      const n = (got['mock.pdfOcr'] as number | undefined) ?? 0;
      await chrome.storage.local.set({ 'mock.pdfOcr': n + 1, 'mock.pdfOcrPages': [...((got['mock.pdfOcrPages'] as number[] | undefined) ?? []), ...(pages ?? [])] });
      await sleep(700);
      const list = pages?.length ? pages : [1];
      const paras: [string, [number, number, number, number]][] = [
        ['Local-first translation for the web', [72, 70, 540, 104]],
        ['This paragraph explains why a small local model can beat classic machine translation while staying fast. The page keeps its layout.', [72, 130, 540, 230]],
        ['Links, code and numbers such as 42 stay untouched. Only the text between them is translated by the model.', [72, 250, 540, 330]],
      ];
      return {
        documentId: 'mock',
        warnings: [],
        pages: list.map((page) => ({
          page,
          width: 612,
          height: 792,
          scanned: false,
          paragraphs: paras.map(([source, box], i) => ({ id: `p${page}-${i}`, source, translation: pseudoTranslate(source, 'final'), box, provider: 'mock' })),
        })),
      };
    },
    'ui:openOptions': async ({ tab }) => {
      await chrome.tabs.create({ url: chrome.runtime.getURL('options.html' + (tab ? '#' + tab : '')) });
      return { ok: true as const };
    },
  });
}

const AUTOSTART = { enabled: false };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function handleTranslatePort(port: chrome.runtime.Port) {
  const timers = new Map<string, number[]>(); // `${jobId}|${segId}` → timers
  const send = (m: TranslateServerMsg) => {
    try {
      port.postMessage(m);
    } catch {
      /* 端口已断开 */
    }
  };
  port.onMessage.addListener((msg: TranslateClientMsg) => {
    if (msg.type === 'cancel') {
      for (const [k, ts] of timers) {
        const [j, s] = k.split('|');
        if (j === msg.jobId && (!msg.segmentIds || msg.segmentIds.includes(s))) {
          ts.forEach(clearTimeout);
          timers.delete(k);
        }
      }
      return;
    }
    if (msg.type !== 'job') return;
    const { job } = msg;
    // 给测试看：最近一次任务用的语言
    void chrome.storage.local.set({ 'mock.lastJob': { sourceLang: job.sourceLang, targetLang: job.targetLang, mode: job.mode, kind: job.segments[0]?.kind } });
    // 目标不是中文时（输入框翻译成英语等），给出一眼能认出来的假译文
    const foreign = !!job.targetLang && !/^zh/i.test(job.targetLang);
    const fake = (text: string, st: 'fast' | 'final') => (foreign ? `[${job.targetLang}] ${text}` : pseudoTranslate(text, st));
    const stages: ('fast' | 'final')[] = job.mode === 'combined' ? ['fast', 'final'] : ['final'];
    const base = job.priority === 0 ? 0 : 250;
    for (const stage of stages) {
      const left = new Set(job.segments.map((s) => s.id));
      job.segments.forEach((seg, i) => {
        const delay =
          base +
          (stage === 'fast' || job.mode === 'fast' ? 120 + Math.random() * 120 : 650 + Math.random() * 500) +
          i * (stage === 'fast' ? 8 : 25);
        const key = `${job.jobId}|${seg.id}`;
        const t = setTimeout(() => {
          left.delete(seg.id);
          if (/NOPROVIDER/.test(seg.text)) {
            send({ type: 'error', jobId: job.jobId, segmentId: seg.id, stage, error: { code: 'no_provider', message: '没有可用的翻译服务', retryable: false } });
          } else if (/fail/i.test(seg.text) && stage === 'final') {
            send({ type: 'error', jobId: job.jobId, segmentId: seg.id, stage, error: { code: 'server', message: '模拟失败', provider: 'mock', retryable: true } });
          } else {
            const queueMs = Math.round(5 + Math.random() * 30);
            send({ type: 'result', jobId: job.jobId, segmentId: seg.id, text: fake(seg.text, job.mode === 'fast' ? 'fast' : stage), stage, provider: stage === 'fast' ? 'mock-fast' : 'mock-accurate', cached: false,
              timing: { queueMs, providerMs: Math.round(delay - queueMs), ...(job.stream && stage === 'final' ? { firstTokenMs: Math.round(delay * 0.35) } : {}), retries: 0 } });
          }
          if (!left.size) send({ type: 'job-done', jobId: job.jobId, stage });
        }, delay) as unknown as number;
        timers.set(key, [...(timers.get(key) ?? []), t]);
        // 模拟大模型流式输出：精确档在出完整结果前，分几次发「到目前为止的译文」（会故意停在半个占位符上）
        if (job.stream && stage === 'final' && job.mode !== 'fast' && !/fail|NOPROVIDER/i.test(seg.text)) {
          const full = fake(seg.text, 'final');
          const steps = 6;
          for (let k = 1; k < steps; k++) {
            const at = delay * (0.35 + (0.6 * k) / steps);
            const cut = Math.max(1, Math.round((full.length * k) / steps));
            const pt = setTimeout(() => send({ type: 'partial', jobId: job.jobId, segmentId: seg.id, stage, text: full.slice(0, cut) }), at) as unknown as number;
            timers.set(key, [...(timers.get(key) ?? []), pt]);
          }
        }
      });
    }
  });
  port.onDisconnect.addListener(() => {
    for (const ts of timers.values()) ts.forEach(clearTimeout);
    timers.clear();
  });
}

function handleStatusPort(port: chrome.runtime.Port) {
  const push = () => {
    try {
      port.postMessage({ type: 'snapshot', status: sampleStatus() });
    } catch {
      clearInterval(iv);
    }
  };
  // 真后端翻译过程中快照很频繁；这里每 400ms 推一次，用来测界面在频繁更新下不抖、不吞点击
  const iv = setInterval(push, 400);
  push();
  port.onMessage.addListener((m: { type: string; providerId?: string; action?: string }) => {
    if (m.type === 'provider-action' && m.providerId) {
      if (m.action === 'pin') PINNED.add(m.providerId);
      else if (m.action === 'unpin') PINNED.delete(m.providerId);
    }
    setTimeout(push, 200);
  });
  port.onDisconnect.addListener(() => clearInterval(iv));
}

const zhWords = new Intl.Segmenter('zh', { granularity: 'word' });

/** 假对齐：两边按词切分，按相对位置一一对应。真后端用 awesome-align / SimAlign。 */
function align(p: { id: string; source: string; target: string }): AlignResult {
  const srcTokens: [number, number][] = [];
  for (const m of p.source.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)) srcTokens.push([m.index!, m.index! + m[0].length]);
  const tgtTokens: [number, number][] = [];
  for (const s of zhWords.segment(p.target)) if (s.isWordLike) tgtTokens.push([s.index, s.index + s.segment.length]);
  const links: [number, number][] = [];
  const n = srcTokens.length;
  const m = tgtTokens.length;
  if (n && m) for (let i = 0; i < n; i++) links.push([i, Math.round((i * (m - 1)) / Math.max(1, n - 1))]);
  // 句数相同时按顺序给出整句范围（真后端只在有依据时才给）
  const sents = (t: string, re: RegExp) => [...t.matchAll(re)].map((x) => [x.index!, x.index! + x[0].length] as [number, number]);
  const ss = sents(p.source, /[^.!?]+[.!?]+\s*/g);
  const ts = sents(p.target, /[^。！？.!?]+[。！？.!?]+/g);
  const spans = ss.length > 1 && ss.length === ts.length ? ss.map((x, i) => ({ kind: 'sentence' as const, source: x, target: ts[i] })) : undefined;
  return { id: p.id, srcTokens, tgtTokens, links, ...(spans ? { spans } : {}) };
}
