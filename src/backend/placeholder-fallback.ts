import { tokenize, checkPlaceholders } from '../shared/placeholders';
import { ProviderError } from './providers/types';
import { validTranslation } from './validation';
import { PlaceholderMeasurements, type PlaceholderDiagnostic, type PlaceholderDiagnosticHandler } from './placeholder-diagnostics';

/** 标签始终留在本机，模型只翻译叶子文字；用于模型两次丢标签后的最终可靠降级。 */
export async function translateTextLeaves(source: string, translate: (text: string) => Promise<string>, signal: AbortSignal, options: { onDiagnostic?: PlaceholderDiagnosticHandler } = {}): Promise<string> {
  const measurements = new PlaceholderMeasurements('placeholder-leaves', 'leaves', source.length, options.onDiagnostic);
  let outcome: PlaceholderDiagnostic['outcome'] = 'error';
  try {
    signal.throwIfAborted();
    if (!checkPlaceholders(source, source).ok) throw new ProviderError({ code: 'bad_input', message: '原文占位符结构不合法', retryable: false });
    const tokens = tokenize(source);
    measurements.record.groups = tokens.filter((token) => token.kind === 'open').length;
    measurements.record.atoms = tokens.filter((token) => token.kind === 'atom').length;
    if (!tokens.length) throw new ProviderError({ code: 'placeholder', message: '纯文本译文包含意外标记', retryable: false });
    const pieces: string[] = [];
    let previous = 0;
    const leaf = async (text: string) => {
      signal.throwIfAborted();
      if (!text.trim() || !/[\p{L}\p{N}]/u.test(text)) return text;
      const value = await measurements.model('leafCalls', () => translate(text.trim()));
      if (!validTranslation(text.trim(), value)) throw new ProviderError({ code: 'placeholder', message: '文本叶子译文未通过校验', retryable: false });
      return (text.match(/^\s*/)?.[0] ?? '') + value.trim() + (text.match(/\s*$/)?.[0] ?? '');
    };
    for (const token of tokens) {
      pieces.push(await leaf(source.slice(previous, token.index)), source.slice(token.index, token.index + token.length));
      previous = token.index + token.length;
    }
    pieces.push(await leaf(source.slice(previous)));
    signal.throwIfAborted();
    const result = pieces.join('');
    if (!validTranslation(source, result)) throw new ProviderError({ code: 'placeholder', message: '本地标签还原失败', retryable: false });
    outcome = 'success';
    return result;
  } catch (error) { outcome = signal.aborted ? 'cancelled' : 'error'; throw error; }
  finally { measurements.finish(outcome); }
}
