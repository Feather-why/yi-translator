import { offscreenRequest } from './align/offscreen-client';
import { ProviderError, type BuiltinTranslatorAvailability, type BuiltinTranslatorBridge, type ProviderRequest } from './providers/types';
import type { ErrorInfo } from '../shared/protocol';
import { stripPlaceholders } from '../shared/placeholders';
import { browserLanguage } from './browser-translator-engine';

type Request = <T>(task: string, payload: unknown, timeoutMs?: number) => Promise<T>;
type Response = { ok: true; texts: string[] } | { ok: false; error: ErrorInfo };
export interface BrowserLanguageDetection { isReliable: boolean; languages: { language: string; percentage: number }[] }
type Detect = (text: string) => Promise<BrowserLanguageDetection>;
function currentDetector(): Detect | undefined {
  // offscreen 只能调用 runtime；扩展自带的 CLD 必须在后台窗口一侧运行。
  const api = (globalThis as typeof globalThis & { chrome?: { i18n?: { detectLanguage: Detect } } }).chrome?.i18n;
  return typeof api?.detectLanguage === 'function' ? (text) => api.detectLanguage(text) : undefined;
}
async function reliableSource(detect: Detect, texts: string[], signal: AbortSignal): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await waitWithAbort(Promise.race([detect(stripPlaceholders(texts.join('\n'))), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1000); })]), signal);
    const first = result?.languages?.[0];
    if (!result?.isReliable || !first || !Number.isFinite(first.percentage) || first.percentage < 90 || first.language === 'und' || result.languages.slice(1).some((language) => language.percentage >= 10)) return undefined;
    return Intl.getCanonicalLocales(first.language)[0];
  } catch { signal.throwIfAborted(); return undefined; }
  finally { if (timer) clearTimeout(timer); }
}
function waitWithAbort<T>(work: Promise<T>, signal: AbortSignal, abortWork?: () => void): Promise<T> {
  if (signal.aborted) { abortWork?.(); return Promise.reject(signal.reason ?? new DOMException('取消', 'AbortError')); }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); abortWork?.(); reject(signal.reason ?? new DOMException('取消', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    void work.then((value) => { cleanup(); if (signal.aborted) reject(signal.reason); else resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
/** 只传本机消息，不经过网络、不传网站 Cookie，取消会通知真实 Window 会话。 */
export function createBrowserTranslatorBridge(request: Request = offscreenRequest, detect: Detect | undefined = currentDetector(), now: () => number = Date.now): BuiltinTranslatorBridge {
  let generation = 0;
  const negative = new Map<string, { expires: number; error: ErrorInfo }>();
  const keyOf = (source: string, target: string) => source === 'auto' ? undefined : JSON.stringify([browserLanguage(source), browserLanguage(target)]);
  const lookup = (key: string | undefined) => {
    const entry = key ? negative.get(key) : undefined;
    if (entry && entry.expires > now()) return entry.error;
    if (key) negative.delete(key);
    return undefined;
  };
  const remember = (key: string | undefined, error: ErrorInfo, started = generation) => {
    if (started !== generation || !key || error.code !== 'no_provider') return;
    // 不可用按真实语言对短暂跳过，不能把一种语言没下载变成整家服务熔断。
    negative.set(key, { expires: now() + 15_000, error });
    if (negative.size > 64) negative.delete(negative.keys().next().value!);
  };
  return {
    unavailable(source, target) { return !!lookup(keyOf(source, target)); },
    invalidate(source, target) { generation++; if (source && target && source !== 'auto') negative.delete(keyOf(source, target)!); else negative.clear(); },
    async availability(sourceLang, targetLang, signal) {
      const started = ++generation;
      // auto 没有固定语言对；此处只显示准备情况，每个请求仍按真实识别语言重新检查。
      const status = await waitWithAbort(request<BuiltinTranslatorAvailability>('browser-translator:availability', { sourceLang: sourceLang === 'auto' && detect ? 'en' : sourceLang, targetLang }, 3000), signal);
      const key = keyOf(sourceLang, targetLang);
      if (key && started === generation) {
        if (status.status === 'available') negative.delete(key);
        else remember(key, { code: 'no_provider', message: status.reason || '浏览器内置语言包尚未准备，将使用其他服务', retryable: true });
      }
      return detect ? { ...status, ...(sourceLang === 'auto' ? { sourceLanguage: 'auto' } : {}), supportsAuto: true, detectorStatus: 'available' } : status;
    },
    async translate(input: ProviderRequest, signal) {
      signal.throwIfAborted();
      let sourceLang = input.sourceLang;
      if (sourceLang === 'auto' && detect && /[\p{L}]/u.test(stripPlaceholders(input.texts.join('\n')))) {
        const detected = await reliableSource(detect, input.texts, signal);
        if (!detected) throw new ProviderError({ code: 'no_provider', message: '浏览器无法可靠识别原文语言，将使用其他服务', retryable: true });
        sourceLang = detected;
      }
      const key = keyOf(sourceLang, input.targetLang);
      const unavailable = lookup(key);
      if (unavailable) throw new ProviderError(unavailable);
      const started = generation;
      const id = crypto.randomUUID();
      const cancel = () => { void request('browser-translator:cancel', { id }, 2000).catch(() => undefined); };
      let response: Response;
      try { response = await waitWithAbort(request<Response>('browser-translator:translate', { id, texts: input.texts, sourceLang, targetLang: input.targetLang }, 12000), signal, cancel); }
      catch (error) {
        if (signal.aborted) throw error;
        cancel();
        const info: ErrorInfo = { code: 'no_provider', message: '浏览器内置翻译窗口未就绪，将使用其他服务', retryable: true };
        remember(key, info, started); throw new ProviderError(info);
      }
      if (!response?.ok) {
        const error: ErrorInfo = response && 'error' in response ? response.error : { code: 'no_provider', message: '浏览器内置翻译返回异常', retryable: true };
        remember(key, error, started); throw new ProviderError(error);
      }
      if (key && started === generation) negative.delete(key);
      return response.texts;
    },
  };
}
