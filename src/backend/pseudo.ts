import { defineProvider } from './providers/types';
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



/** 仅由开发入口或专用 backend-test 构建注册，正式构建不注册。 */
export const pseudo = defineProvider({
  id: 'pseudo', name: '开发回放（非真实翻译）', version: '1.0.0', kind: 'builtin', official: true,
  usedFor: ['fast', 'accurate', 'combined'], auth: [], limits: { maxChars: 4000, maxSegments: 40, concurrency: 8 }, placeholders: 'prompt',
  async translate(request, context) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 15);
      context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('取消', 'AbortError')); }, { once: true });
    });
    return request.texts.map((text) => pseudoTranslate(text, 'final'));
  },
  classifyError: () => ({ code: 'internal', message: '开发回放失败', retryable: false }),
});

