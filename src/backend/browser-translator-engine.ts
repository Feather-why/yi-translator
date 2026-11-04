import type { ErrorInfo } from '../shared/protocol';
import { stripPlaceholders } from '../shared/placeholders';
import { ProviderError, type BuiltinAvailabilityStatus, type BuiltinTranslatorAvailability } from './providers/types';

interface NativeSession { translate(text: string, options?: { signal?: AbortSignal }): Promise<string>; destroy(): void }
interface NativeDetector { detect(text: string, options?: { signal?: AbortSignal }): Promise<{ detectedLanguage: string; confidence: number }[]>; destroy(): void }
export interface NativeTranslatorApi {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: { sourceLanguage: string; targetLanguage: string; signal?: AbortSignal; monitor?: (monitor: EventTarget) => void }): Promise<NativeSession>;
}
export interface NativeDetectorApi { availability(): Promise<string>; create(options?: { signal?: AbortSignal; monitor?: (monitor: EventTarget) => void }): Promise<NativeDetector> }
export interface BrowserEnvironment { translator?: NativeTranslatorApi; detector?: NativeDetectorApi; secure: boolean }
const unavailable = (message: string) => new ProviderError({ code: 'no_provider', message, retryable: true });
const badInput = (message: string) => new ProviderError({ code: 'bad_input', message, retryable: false });
const known = (value: string): BuiltinAvailabilityStatus => ['available', 'downloadable', 'downloading', 'unavailable'].includes(value) ? value as BuiltinAvailabilityStatus : 'unavailable';
export function browserLanguage(value: unknown): string {
  if (typeof value !== 'string' || value.length > 80 || value === 'auto') throw badInput('内置翻译需要明确且有效的语言');
  let code: string;
  try { code = Intl.getCanonicalLocales(value)[0]!; } catch { throw badInput('翻译语言代码无效'); }
  if (!code) throw badInput('翻译语言代码无效');
  if (/^zh-(?:TW|HK|MO|Hant)(?:-|$)/i.test(code)) return 'zh-Hant';
  if (/^zh(?:-|$)/i.test(code)) return 'zh';
  return code;
}
function currentEnvironment(): BrowserEnvironment {
  const environment = globalThis as typeof globalThis & { Translator?: NativeTranslatorApi; LanguageDetector?: NativeDetectorApi };
  return { translator: environment.Translator, detector: environment.LanguageDetector, secure: globalThis.isSecureContext === true };
}
function deadline<T>(promise: Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('取消', 'AbortError'));
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('取消', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(unavailable('浏览器内置模型响应超时，将使用其他服务')); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    void promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

export class BrowserTranslatorEngine {
  private sessions = new Map<string, { session: NativeSession; lastUsed: number }>();
  private creating = new Map<string, Promise<NativeSession>>();
  private detector?: NativeDetector;
  private detectorCreation?: Promise<NativeDetector>;
  private generation = 0;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(private environment: () => BrowserEnvironment = currentEnvironment) {}
  async availability(sourceLang: string, targetLang: string, signal = new AbortController().signal): Promise<BuiltinTranslatorAvailability> {
    const targetLanguage = browserLanguage(targetLang), sourceLanguage = sourceLang === 'auto' ? 'auto' : browserLanguage(sourceLang);
    const environment = this.environment();
    const base: BuiltinTranslatorAvailability = { status: 'unavailable', sourceLanguage, targetLanguage, supportsAuto: false, detectorStatus: 'unavailable' };
    if (!environment.secure || !environment.translator) return { ...base, reason: '当前浏览器上下文没有可用的 Translator API' };
    try {
      const [status, detectorStatus] = await Promise.all([
        deadline(environment.translator.availability({ sourceLanguage: sourceLanguage === 'auto' ? 'en' : sourceLanguage, targetLanguage }), signal, 2000),
        // 明确语言（包括后台CLD已识别的结果）不依赖检测模型，不能逐段多等一次可选模型检查。
        sourceLanguage === 'auto' && environment.detector ? deadline(environment.detector.availability(), signal, 2000).catch(() => 'unavailable') : Promise.resolve('unavailable'),
      ]);
      base.status = known(status); base.detectorStatus = known(detectorStatus); base.supportsAuto = base.detectorStatus === 'available';
      if (sourceLanguage === 'auto' && !base.supportsAuto) return { ...base, status: base.detectorStatus, reason: '浏览器自动语言检测模型尚未准备，将使用其他服务' };
      if (base.status === 'downloadable' || base.status === 'downloading') return { ...base, reason: '浏览器语言包尚未准备，请在设置→翻译服务→浏览器内置翻译的语言包卡片点击下载' };
      if (base.status !== 'available') return { ...base, reason: '此设备或语言对暂不支持浏览器内置翻译' };
      return base;
    } catch (error) { signal.throwIfAborted(); return { ...base, reason: error instanceof ProviderError ? error.info.message : '浏览器内置模型可用性检查失败' }; }
  }
  private armIdle() { if (this.idle) clearTimeout(this.idle); this.idle = setTimeout(() => this.dispose(), 600000); }
  private async session(sourceLanguage: string, targetLanguage: string, signal: AbortSignal): Promise<NativeSession> {
    const key = `${sourceLanguage}:${targetLanguage}`, cached = this.sessions.get(key);
    if (cached) { cached.lastUsed = Date.now(); return cached.session; }
    let creation = this.creating.get(key);
    if (!creation) {
      const api = this.environment().translator;
      if (!api) throw unavailable('此窗口不支持浏览器内置翻译');
      const generation = this.generation; let abandoned = false;
      // 原生 create 不一定及时响应取消；迟到的对象不能留在缓存或泄漏模型内存。
      const native = api.create({ sourceLanguage, targetLanguage, signal }).then((session) => {
        if (abandoned || signal.aborted || generation !== this.generation) { session.destroy(); throw unavailable('内置翻译会话已取消'); }
        return session;
      });
      creation = deadline(native, signal, 8000).then((session) => {
        if (signal.aborted || generation !== this.generation) { session.destroy(); throw unavailable('内置翻译会话已取消'); }
        this.sessions.set(key, { session, lastUsed: Date.now() });
        while (this.sessions.size > 3) {
          const oldest = [...this.sessions.entries()].sort((a,b) => a[1].lastUsed - b[1].lastUsed)[0]!;
          oldest[1].session.destroy(); this.sessions.delete(oldest[0]);
        }
        return session;
      }).catch((error) => { abandoned = true; throw error; }).finally(() => { if (this.creating.get(key) === creation) this.creating.delete(key); });
      this.creating.set(key, creation);
    }
    return deadline(creation, signal, 8000);
  }
  private async sourceLanguage(text: string, signal: AbortSignal): Promise<string> {
    const environment = this.environment();
    if (!environment.detector || known(await deadline(environment.detector.availability(), signal, 2000)) !== 'available') throw unavailable('浏览器自动语言检测模型尚未准备，将使用其他服务');
    if (!this.detectorCreation) {
      const generation = this.generation; let abandoned = false;
      const native = environment.detector.create({ signal }).then((detector) => {
        if (abandoned || signal.aborted || generation !== this.generation) { detector.destroy(); throw unavailable('自动语言检测会话已取消'); }
        return detector;
      });
      const creation = deadline(native, signal, 8000).then((detector) => {
        if (signal.aborted || generation !== this.generation) { detector.destroy(); throw unavailable('自动语言检测会话已取消'); }
        this.detector = detector; return detector;
      }).catch((error) => { abandoned = true; if (this.detectorCreation === creation) this.detectorCreation = undefined; throw error; });
      this.detectorCreation = creation;
    }
    const detector = await deadline(this.detectorCreation, signal, 8000);
    const results = await deadline(detector.detect(text, { signal }), signal, 5000);
    const first = results[0];
    if (!first || typeof first.detectedLanguage !== 'string' || !Number.isFinite(first.confidence) || first.confidence < 0.8 || (results[1]?.confidence ?? 0) >= 0.2) throw unavailable('浏览器无法可靠识别原文语言，将使用其他服务');
    return browserLanguage(first.detectedLanguage);
  }
  async translate(input: { texts: string[]; sourceLang: string; targetLang: string }, signal = new AbortController().signal): Promise<string[]> {
    signal.throwIfAborted();
    if (!input || !Array.isArray(input.texts) || !input.texts.length || input.texts.length > 8 || input.texts.some((text) => typeof text !== 'string' || text.length > 2000)) throw badInput('浏览器内置翻译片段格式无效');
    const targetLanguage = browserLanguage(input.targetLang);
    const sample = stripPlaceholders(input.texts.join('\n')).trim();
    if (!/[\p{L}]/u.test(sample)) return input.texts.slice();
    const sourceLanguage = input.sourceLang === 'auto' ? await this.sourceLanguage(sample, signal) : browserLanguage(input.sourceLang);
    if (sourceLanguage === targetLanguage) return input.texts.slice();
    const availability = await this.availability(sourceLanguage, targetLanguage, signal);
    if (availability.status !== 'available') throw unavailable(availability.reason || '浏览器内置语言包未准备');
    let session: NativeSession;
    try { session = await this.session(sourceLanguage, targetLanguage, signal); }
    catch { signal.throwIfAborted(); throw unavailable('内置翻译会话无法创建，请在设置→翻译服务→浏览器内置翻译的语言包卡片检查语言包'); }
    if (this.idle) clearTimeout(this.idle);
    try {
      const output: string[] = [];
      for (const text of input.texts) {
        signal.throwIfAborted();
        const translated = await deadline(session.translate(text, { signal }), signal, 8000);
        if (typeof translated !== 'string' || !translated.trim()) throw unavailable('浏览器内置翻译未返回有效结果');
        output.push(translated);
      }
      return output;
    } catch (error) {
      this.sessions.delete(`${sourceLanguage}:${targetLanguage}`); session.destroy(); signal.throwIfAborted();
      if (error instanceof ProviderError) throw error;
      throw unavailable('浏览器内置模型暂时不可用，将使用其他服务');
    } finally { this.armIdle(); }
  }
  dispose() {
    this.generation++; this.creating.clear();
    if (this.idle) clearTimeout(this.idle); this.idle = undefined;
    for (const { session } of this.sessions.values()) session.destroy();
    this.sessions.clear(); this.detector?.destroy(); this.detector = undefined; this.detectorCreation = undefined;
  }
}
export type BrowserTranslateResponse = { ok: true; texts: string[] } | { ok: false; error: ErrorInfo };
