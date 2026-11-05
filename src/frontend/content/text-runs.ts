/** 一段连续的 UTF-16 文本位置。占位符不对应原文，折叠掉的空白也不占输出位置。 */
export interface TextRun {
  start: number;
  end: number;
  node: Text;
  offset: number;
}

const ASCII_SPACE = /[ \t\n\r\f\u00a0]+/g;
const UNICODE_SPACE = /\s+/g;

export class MappedText {
  readonly runs: TextRun[] = [];
  length = 0;
  letters = 0;
  lastSpace = true;
  private pieces: string[] = [];

  constructor(private unicodeSpace = false) {}

  append(value: string): void {
    if (value) {
      this.pieces.push(value);
      this.length += value.length;
    }
  }

  mapped(value: string, node: Text, offset: number): void {
    if (!value) return;
    const last = this.runs[this.runs.length - 1];
    const start = this.length;
    this.append(value);
    if (last && last.node === node && last.end === start && last.offset + last.end - last.start === offset) last.end = this.length;
    else this.runs.push({ start, end: this.length, node, offset });
  }

  add(node: Text, from = 0, to = node.data.length): void {
    if (to <= from) return;
    const value = node.data.slice(from, to);
    const whitespace = this.unicodeSpace ? UNICODE_SPACE : ASCII_SPACE;
    let copyFrom = 0;
    this.letters += value.length;
    whitespace.lastIndex = 0;
    for (let match = whitespace.exec(value); match; match = whitespace.exec(value)) {
      const at = match.index;
      this.letters -= match[0].length;
      const omit = at === 0 && this.lastSpace;
      // 普通单个空格可直接随整段拷贝，避免为每个词分配对象。
      if (!omit && match[0] === ' ') continue;
      this.mapped(value.slice(copyFrom, at), node, from + copyFrom);
      if (!omit) this.mapped(' ', node, from + at);
      copyFrom = whitespace.lastIndex;
    }
    this.mapped(value.slice(copyFrom), node, from + copyFrom);
    const last = value.charCodeAt(value.length - 1);
    this.lastSpace = this.unicodeSpace ? /\s/.test(value[value.length - 1]) : last === 32 || last === 9 || last === 10 || last === 12 || last === 13 || last === 160;
  }

  popSpace(): { node: Text; offset: number } | undefined {
    const last = this.runs[this.runs.length - 1];
    const piece = this.pieces[this.pieces.length - 1];
    if (!last || last.end !== this.length || !piece.endsWith(' ')) return;
    const offset = last.offset + last.end - last.start - 1;
    if (--last.end === last.start) this.runs.pop();
    if (piece.length === 1) this.pieces.pop();
    else this.pieces[this.pieces.length - 1] = piece.slice(0, -1);
    this.length--;
    return { node: last.node, offset };
  }

  text(): string { return this.pieces.join(''); }
}

/** 返回开始于 end 之前的最后一个区间，供句末和选区端点查找使用。 */
export function runBefore(runs: TextRun[], end: number): TextRun | undefined {
  let lo = 0, hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (runs[mid].start < end) lo = mid + 1;
    else hi = mid;
  }
  return runs[lo - 1];
}
