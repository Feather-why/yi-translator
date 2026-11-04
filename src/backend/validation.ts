import { checkPlaceholders, tokenize } from '../shared/placeholders';

/** 数量与平衡之外还固定父子关系，防止模型把链接或代码挪出原来的格式节点。 */
export function validTranslation(source: string, target: unknown): target is string {
  if (typeof target !== 'string' || (!target.trim() && source.trim()) || !checkPlaceholders(source, target).ok) return false;
  const parents = (text: string) => {
    const stack: string[] = [];
    const result: string[] = [];
    for (const token of tokenize(text)) {
      if (token.kind === 'close') stack.pop();
      else { result.push(`${token.name}:${stack.join('/')}`); if (token.kind === 'open') stack.push(token.name); }
    }
    return result.sort().join('|');
  };
  return parents(source) === parents(target);
}

