import type { AlignPair, AlignResult } from '../shared/protocol';
import { checkPlaceholders, tokenize } from '../shared/placeholders';
import { validAlignment } from './align/algorithm';
import { validTranslation } from './validation';
import { PlaceholderMeasurements, type PlaceholderDiagnostic, type PlaceholderDiagnosticHandler } from './placeholder-diagnostics';

export interface TranslationTerm { source: string; target: string }
export interface ProjectionOptions {
  sourceLang: string;
  targetLang: string;
  align?: (pair: AlignPair, signal: AbortSignal) => Promise<AlignResult | undefined>;
  lookup?: (word: string) => Promise<{ translations: string[] } | null>;
  strategy?: 'anchored' | 'lazy';
  /** 嵌套的局部父/子节点必须有独立短语证据，不能只按宽泛模型范围放回链接。 */
  semanticNesting?: boolean;
  onDiagnostic?: PlaceholderDiagnosticHandler;
}
interface Group { name: string; start: number; end: number; children: Group[]; parent?: Group; range?: [number, number]; anchor?: string; meanings?: string[] }
interface Parsed { plain: string; groups: Group[]; roots: Group[]; atoms: { marker: string; original: string }[]; atomPattern: RegExp }

export const NESTED_PROJECTION_REVISION = 'nested-semantic-v1';

/** 只针对没有独立重复短语的合法嵌套结构；不同语境的bank不能共用一个孤立词义。 */
export function hasNestedPlaceholders(source: string): boolean {
  const parsed = parse(source);
  if (!parsed || !parsed.groups.some((group) => group.parent)) return false;
  const phrases = new Map<string, Group[]>();
  for (const group of parsed.groups) {
    const phrase = parsed.plain.slice(group.start, group.end).trim();
    const previous = phrases.get(phrase) ?? [];
    if (phrase && previous.some((other) => (other.start !== group.start || other.end !== group.end)
      && !ancestor(other, group) && !ancestor(group, other))) return false;
    previous.push(group); phrases.set(phrase, previous);
  }
  return true;
}

function parse(source: string): Parsed | undefined {
  if (!checkPlaceholders(source, source).ok) return;
  let nonce = 0;
  while (source.includes(`[TXP${nonce}_`)) nonce++;
  const prefix = `TXP${nonce}_`;
  const atoms: Parsed['atoms'] = [], groups: Group[] = [], roots: Group[] = [], stack: Group[] = [];
  let plain = '', previous = 0;
  for (const token of tokenize(source)) {
    plain += source.slice(previous, token.index);
    if (token.kind === 'atom') {
      const marker = `[${prefix}${atoms.length}]`;
      atoms.push({ marker, original: source.slice(token.index, token.index + token.length) });
      plain += marker;
    } else if (token.kind === 'open') {
      const parent = stack.at(-1);
      const group: Group = { name: token.name, start: plain.length, end: -1, children: [], ...(parent ? { parent } : {}) };
      (parent ? parent.children : roots).push(group); groups.push(group); stack.push(group);
    } else {
      const group = stack.pop();
      if (!group || group.name !== token.name) return;
      group.end = plain.length;
    }
    previous = token.index + token.length;
  }
  plain += source.slice(previous);
  if (stack.length) return;
  return { plain, groups, roots, atoms, atomPattern: new RegExp(`\\[${prefix}\\d+\\]`, 'g') };
}

function occurrences(text: string, phrase: string): [number, number][] {
  if (!phrase) return [];
  const matches: [number, number][] = [];
  for (let at = text.indexOf(phrase); at >= 0 && matches.length < 32; at = text.indexOf(phrase, at + Math.max(1, phrase.length))) matches.push([at, at + phrase.length]);
  return matches;
}
function ancestor(a: Group, b: Group): boolean {
  for (let parent = b.parent; parent; parent = parent.parent) if (parent === a) return true;
  return false;
}
function dictionaryMeanings(translations: string[]): string[] {
  return [...new Set(translations.flatMap((line) => line.replace(/\\n/g, '\n').split(/[\n,，;；]/u))
    .map((value) => value.replace(/\[[^\]]+\]/g, '').replace(/^(?:[A-Za-z]{1,6}\.\s*)+/, '').trim())
    .filter((value) => value.length > 0 && value.length <= 24 && /\p{Script=Han}/u.test(value) && !/[<>\[\]]/u.test(value)))];
}
function exactCandidates(group: Group, plain: string, target: string, groups: Group[]): [number, number][] {
  const phrase = plain.slice(group.start, group.end).trim();
  const anchor = occurrences(target, group.anchor ?? phrase).filter((range) => fits(group, range, groups));
  if (anchor.length) return anchor;
  const unique = new Map<string, [number, number]>();
  for (const meaning of group.meanings ?? []) for (const range of occurrences(target, meaning)) if (fits(group, range, groups)) unique.set(range.join(':'), range);
  return [...unique.values()].sort((a, b) => a[0] - b[0]);
}
function fits(group: Group, range: [number, number], groups: Group[]): boolean {
  for (const other of groups) {
    if (other === group || !other.range) continue;
    const [a, b] = other.range;
    if (ancestor(other, group)) { if (range[0] < a || range[1] > b) return false; }
    else if (ancestor(group, other)) { if (a < range[0] || b > range[1]) return false; }
    else if (range[0] < b && range[1] > a) return false;
  }
  return true;
}

/** 仅接受有词级证据的范围，句子级兜底不能替一个链接定位到整段。 */
function alignedRange(group: Group, pair: AlignPair, alignment: AlignResult): [number, number] | undefined {
  const lexical = (text: string, span: [number, number]) => /[\p{L}\p{N}]/u.test(text.slice(...span));
  const selected = alignment.srcTokens.map((span, index) => ({ span, index }))
    .filter(({ span }) => span[0] < group.end && span[1] > group.start && lexical(pair.source, span));
  if (!selected.length) return;
  const selectedIds = new Set(selected.map(({ index }) => index));
  const links = alignment.links.filter(([source, target]) => selectedIds.has(source) && lexical(pair.target, alignment.tgtTokens[target]!));
  if (new Set(links.map(([source]) => source)).size / selected.length < 0.5) return;
  const indices = [...new Set(links.map(([, target]) => target))];
  if (!indices.length || indices.length > Math.max(4, selected.length * 3)) return;
  const a = Math.min(...indices.map((index) => alignment.tgtTokens[index]![0]));
  const b = Math.max(...indices.map((index) => alignment.tgtTokens[index]![1]));
  const sourceWords = alignment.srcTokens.filter((span) => lexical(pair.source, span)).length;
  const targetWords = alignment.tgtTokens.filter((span) => lexical(pair.target, span));
  const covered = targetWords.filter((span) => span[0] < b && span[1] > a).length;
  if (covered > Math.max(4, selected.length * 3) || covered / Math.max(1, targetWords.length) > Math.min(1, selected.length / Math.max(1, sourceWords) * 2 + 0.1)) return;
  return [a, b];
}

function render(text: string, from: number, to: number, groups: Group[]): string | undefined {
  const sorted = [...groups].sort((a, b) => a.range![0] - b.range![0] || a.range![1] - b.range![1]);
  let output = '', cursor = from;
  for (const group of sorted) {
    if (!group.range || group.range[0] < cursor || group.range[1] > to) return;
    const content = render(text, group.range[0], group.range[1], group.children);
    if (content === undefined) return;
    output += text.slice(cursor, group.range[0]) + `<${group.name}>` + content + `</${group.name}>`;
    cursor = group.range[1];
  }
  return output + text.slice(cursor, to);
}

/**
 * 先生成连贯整句，再定位链接/格式；短词译文只用作锚点，绝不拼成正文。
 * 无法可靠定位时交还 null，由调用者保留严格的最终安全降级。
 */
export async function translateWithProjectedPlaceholders(
  source: string,
  translate: (text: string, terms?: TranslationTerm[], purpose?: 'plain' | 'anchor') => Promise<string>,
  options: ProjectionOptions,
  signal: AbortSignal,
): Promise<string | null> {
  const strategy = options.strategy ?? 'anchored', measurements = new PlaceholderMeasurements('placeholder-projection', strategy, source.length, options.onDiagnostic);
  let outcome: PlaceholderDiagnostic['outcome'] = 'unresolved';
  const success = (result: string) => { outcome = 'success'; return result; };
  try {
    signal.throwIfAborted();
    const parsed = parse(source);
    if (!parsed || !parsed.groups.length && !parsed.atoms.length) return null;
    const { plain, groups, roots, atoms } = parsed;
    const whole = (group: Group) => plain.slice(0, group.start).trim() === '' && plain.slice(group.end).trim() === '';
    const needsSemanticAnchor = (group: Group) => options.semanticNesting === true && (!!group.parent || group.children.length > 0) && !whole(group);
    measurements.record.groups = groups.length; measurements.record.atoms = atoms.length;
    if (!/[\p{L}\p{N}]/u.test(plain.replace(parsed.atomPattern, ''))) return success(source);
    const terms: TranslationTerm[] = [], anchors = new Map<string, string>();
    const collectAnchors = async (candidates: Group[]) => {
      // 两种策略共用六个独立短语预算，嵌套重复和已翻译锚点不再请求。
      const depth = (group: Group) => { let value = 0; for (let parent = group.parent; parent; parent = parent.parent) value++; return value; };
      const ordered = [...candidates].sort((a, b) => (options.semanticNesting ? depth(b) - depth(a) : 0) || b.end - b.start - (a.end - a.start));
      for (const group of ordered) {
        const phrase = plain.slice(group.start, group.end).trim();
        if (!phrase || phrase.length > 80 || phrase === plain.trim() || !/[\p{L}]/u.test(phrase) || /\[TXP\d+_\d+\]/.test(phrase)) continue;
        if (!anchors.has(phrase) && anchors.size < 6) {
          signal.throwIfAborted();
          // 父短语沿用已翻译的后代术语，避免“铜印”父锚点与“青铜印章”子锚点互相冲突。
          const descendants = options.semanticNesting ? terms.filter((term) => groups.some((child) => ancestor(group, child) && plain.slice(child.start, child.end).trim() === term.source)) : [];
          const translated = (await measurements.model('anchorCalls', () => translate(phrase, descendants.length ? descendants.map((term) => ({ ...term })) : undefined, 'anchor'))).trim();
          if (!validTranslation(phrase, translated) || translated.length > 200) return false;
          anchors.set(phrase, translated); terms.push({ source: phrase, target: translated });
        }
        group.anchor = anchors.get(phrase);
      }
      return true;
    };
    if (strategy === 'anchored' && !await collectAnchors(groups)) return null;
    const definitions = new Map<string, string[]>();
    if (options.lookup) for (const group of groups) {
      const phrase = plain.slice(group.start, group.end).trim();
      if (!/^[A-Za-z][A-Za-z'-]{0,39}$/.test(phrase)) continue;
      if (!definitions.has(phrase) && definitions.size < 8) {
        signal.throwIfAborted();
        const entry = await measurements.auxiliary('lookup', async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { return await Promise.race([options.lookup!(phrase).catch(() => null), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 45); })]); }
          finally { if (timer) clearTimeout(timer); }
        });
        definitions.set(phrase, entry ? dictionaryMeanings(entry.translations) : []);
      }
      group.meanings = definitions.get(phrase);
    }
    const alignments = new Map<string, AlignResult | undefined>();
    const restore = async (target: string): Promise<string | null> => {
      signal.throwIfAborted();
      for (const group of groups) group.range = undefined;
      if (!validTranslation(plain, target)) return null;
      const returned = target.match(parsed.atomPattern) ?? [];
      if (returned.length !== atoms.length || atoms.some(({ marker }) => returned.filter((item) => item === marker).length !== 1)) return null;
      const targetStart = target.search(/\S/u), targetEnd = target.trimEnd().length;
      for (const group of groups) {
        if (plain.slice(0, group.start).trim() === '' && plain.slice(group.end).trim() === '') group.range = [Math.max(0, targetStart), targetEnd];
        else if (group.start === group.end && group.start === 0) group.range = [0, 0];
        else if (group.start === group.end && group.end === plain.length) group.range = [target.length, target.length];
      }
      const pair: AlignPair = { id: 'placeholder-projection', source: plain, target, sourceLang: options.sourceLang, targetLang: options.targetLang };
      const candidates = (group: Group) => exactCandidates(group, plain, target, groups).filter(([a, b]) => {
        // 独立短语请求也可能被模型扩写成整段；局部嵌套节点不能因此吞掉外面的正文。
        if (!needsSemanticAnchor(group) || !/[\p{L}\p{N}]/u.test(plain.slice(0, group.start) + plain.slice(group.end))) return true;
        return a > Math.max(0, targetStart) || b < targetEnd;
      });
      // 唯一词面证据先沿父子范围传播；已有确定答案时不再占用CPU/等待语义模型。
      for (let pass = 0; pass < groups.length + 1; pass++) {
        let progress = false;
        for (const group of groups) {
          if (group.range) continue;
          const exact = candidates(group);
          if (exact.length === 1) { group.range = exact[0]!; progress = true; }
        }
        if (!progress) break;
      }
      let alignment = alignments.get(target);
      // 嵌套局部范围必须有锚点；提前跑一次无法采用的宽泛对齐只会增加首段等待。
      if (groups.some((group) => !group.range && !needsSemanticAnchor(group)) && options.align && !alignments.has(target)) {
        try { const value = await measurements.auxiliary('alignment', () => options.align!(pair, signal)); if (validAlignment(pair, value)) alignment = value; }
        catch { signal.throwIfAborted(); }
        alignments.set(target, alignment);
      }
      // 只保留现有精确词面/词典/真实词映射证据，不用源文比例定位格式。
      for (let pass = 0; pass < groups.length + 1; pass++) {
        let progress = false;
        for (const group of groups) {
          if (group.range) continue;
          const exact = candidates(group);
          if (exact.length === 1) { group.range = exact[0]!; progress = true; continue; }
          if (alignment && !needsSemanticAnchor(group)) { const range = alignedRange(group, pair, alignment); if (range && fits(group, range, groups)) { group.range = range; progress = true; } }
        }
        if (!progress) break;
      }
      for (const group of groups) if (!group.range) {
        const exact = candidates(group);
        // 嵌套词组多次出现时不能按首次出现硬贴；没有唯一证据就保留未解决状态。
        if (!needsSemanticAnchor(group) && exact.length > 1 && new Set(exact.map(([a,b]) => target.slice(a,b))).size === 1) group.range = exact[0]!;
      }
      if (groups.some((group) => !group.range || !fits(group, group.range, groups))) return null;
      const projected = render(target, 0, target.length, roots);
      if (projected === undefined) return null;
      let restored = projected;
      for (const { marker, original } of atoms) restored = restored.replace(marker, original);
      return validTranslation(source, restored) ? restored : null;
    };
    const plainTranslation = async () => (await measurements.model('plainCalls', () => translate(plain, terms.length ? terms.map((term) => ({ ...term })) : undefined, 'plain'))).trim();
    let target = await plainTranslation(), restored = await restore(target);
    if (restored !== null) return success(restored);
    if (strategy === 'anchored') return null;
    // 先保住自然正文，只为缺乏证据的节点补锚点；成功时不再重译整句。
    if (!await collectAnchors(groups.filter((group) => !group.range))) return null;
    restored = await restore(target);
    if (restored !== null) return success(restored);
    // 同义词或嵌套无法定位时，回到原先完整术语模板，不拼接孤立短词正文。
    if (!await collectAnchors(groups)) return null;
    if (!alignments.get(target)) alignments.delete(target);
    target = await plainTranslation(); restored = await restore(target);
    return restored === null ? null : success(restored);
  } catch (error) { outcome = signal.aborted ? 'cancelled' : 'error'; throw error; }
  finally { measurements.finish(outcome); }
}
