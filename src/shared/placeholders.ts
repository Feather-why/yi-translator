/**
 * 占位符工具，前后端共用。
 *
 * 成对占位符 <gN>…</gN>：行内元素（链接、加粗等），中间的文字要翻译。
 * 自闭合占位符 <xN/>：网址、代码、邮箱等原样保留的内容。
 */

const TOKEN_RE = /<(\/?)([gx])(\d+)(\/?)>/g;

export interface PlaceholderToken {
  kind: 'open' | 'close' | 'atom';
  name: string; // 'g0'、'x3'
  index: number; // 在字符串中的位置
  length: number;
}

export function tokenize(text: string): PlaceholderToken[] {
  const out: PlaceholderToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text))) {
    const [, slash, letter, num, selfClose] = m;
    const name = `${letter}${num}`;
    if (letter === 'x') {
      if (selfClose) out.push({ kind: 'atom', name, index: m.index, length: m[0].length });
      continue;
    }
    if (selfClose) continue; // <g0/> 不合法，忽略
    out.push({ kind: slash ? 'close' : 'open', name, index: m.index, length: m[0].length });
  }
  return out;
}

/** 去掉所有占位符，得到纯文本（词对齐、语言检测用）。成对占位符保留中间文字。 */
export function stripPlaceholders(text: string): string {
  return text.replace(TOKEN_RE, '');
}

export interface PlaceholderCheck {
  ok: boolean;
  /** 原文有、译文缺的占位符。 */
  missing: string[];
  /** 译文多出来的占位符。 */
  extra: string[];
  /** 成对占位符没有正确闭合或嵌套错乱。 */
  unbalanced: boolean;
}

function multiset(tokens: PlaceholderToken[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) {
    const key = t.kind === 'close' ? `/${t.name}` : t.name;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

function balanced(tokens: PlaceholderToken[]): boolean {
  const stack: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'open') stack.push(t.name);
    else if (t.kind === 'close') {
      if (stack.pop() !== t.name) return false;
    }
  }
  return stack.length === 0;
}

/** 检查译文的占位符是否和原文一一对应。顺序可以变（不同语言语序不同），数量和配对不能变。 */
export function checkPlaceholders(source: string, translated: string): PlaceholderCheck {
  const a = tokenize(source);
  const b = tokenize(translated);
  const ma = multiset(a);
  const mb = multiset(b);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [k, n] of ma) {
    const got = mb.get(k) ?? 0;
    for (let i = got; i < n; i++) missing.push(k);
  }
  for (const [k, n] of mb) {
    const want = ma.get(k) ?? 0;
    for (let i = want; i < n; i++) extra.push(k);
  }
  const unbalanced = !balanced(b);
  return { ok: missing.length === 0 && extra.length === 0 && !unbalanced, missing, extra, unbalanced };
}

/** 原文是否带占位符。不带的话，后端可以用纯文本模式调用接口。 */
export function hasPlaceholders(text: string): boolean {
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(text);
}
