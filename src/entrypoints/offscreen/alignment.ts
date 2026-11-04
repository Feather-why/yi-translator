import { env, pipeline } from '@huggingface/transformers';
import type { AlignPair, AlignResult } from '../../shared/protocol';
import { tokenPieceRanges } from '../../backend/align/algorithm';
import { alignSentencePair } from '../../backend/align/local-pairs';

export const ALIGNMENT_MODEL = 'Xenova/multilingual-e5-small';
export const ALIGNMENT_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
let engine: any;
let loading: Promise<void> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let sequence = Promise.resolve();

export function initializeAlignment(): Promise<void> {
  loading ??= (async () => {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    if (env.backends.onnx.wasm) {
      env.backends.onnx.wasm.proxy = false;
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('assets/onnx/');
    }
    // 只下载固定修订的权重/JSON；执行的 JS 和 WASM 均来自扩展本机包。
    engine = await pipeline('feature-extraction', ALIGNMENT_MODEL, { revision: ALIGNMENT_REVISION, dtype: 'q8', device: 'wasm' });
    armIdle();
  })().catch((error: unknown) => { loading = undefined; throw error; });
  return loading;
}

function armIdle() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => { void engine?.dispose(); engine = undefined; loading = undefined; }, 600000);
}

async function embeddings(text: string, language: string): Promise<number[][]> {
  if (!text.trim()) return [];
  const encode = (value: string) => engine.tokenizer.encode(value, { add_special_tokens: false }) as number[];
  const prefix = 'query: ';
  const total = encode(prefix + text).length;
  const pieces = tokenPieceRanges(text, language, encode, prefix);
  if (total > 254) throw new Error('句子超过本地词对齐 token 上限');
  const tensor = await engine(prefix + text, { pooling: 'none', normalize: false });
  if (!Array.isArray(tensor.dims) || tensor.dims.length !== 3 || tensor.dims[2] !== 384) throw new Error('词对齐模型未返回预期的 BERT 词向量');
  const sequence = tensor.dims[1], dimension = tensor.dims[2];
  if (total + 2 !== sequence) throw new Error('分词与字符边界不一致');
  return pieces.map(([start, end]) => {
    const count = end - start;
    const vector = new Array<number>(dimension).fill(0);
    for (let offset = 0; offset < count; offset++) for (let index = 0; index < dimension; index++) vector[index] = vector[index]! + Number(tensor.data[(1 + start + offset) * dimension + index]) / count;
    return vector;
  });
}

export async function alignPairs(pairs: AlignPair[]): Promise<AlignResult[]> {
  if (!Array.isArray(pairs) || pairs.length > 100) throw new Error('词对齐输入格式无效');
  const task = sequence.then(async () => {
    if (idle) clearTimeout(idle);
    await initializeAlignment();
    if (idle) clearTimeout(idle);
    try {
      const results: AlignResult[] = [];
      for (const pair of pairs) results.push(await alignSentencePair(pair, embeddings));
      return results;
    } finally { armIdle(); }
  });
  sequence = task.then(() => undefined, () => undefined);
  return task;
}
