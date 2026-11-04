import { BrowserTranslatorEngine, type BrowserTranslateResponse } from '../../backend/browser-translator-engine';
import { ProviderError } from '../../backend/providers/types';
const engine = new BrowserTranslatorEngine();
const requests = new Map<string, AbortController>();
export function registerBrowserTranslatorTasks(tasks: Record<string, (payload: any) => Promise<unknown>>) {
  tasks['browser-translator:availability'] = async (payload) => engine.availability(payload.sourceLang, payload.targetLang);
  tasks['browser-translator:cancel'] = async (payload) => { if (typeof payload?.id === 'string') requests.get(payload.id)?.abort(); return { ok: true }; };
  tasks['browser-translator:translate'] = async (payload): Promise<BrowserTranslateResponse> => {
    if (typeof payload?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.id)) return { ok: false, error: { code: 'bad_input', message: '内置翻译任务编号无效', retryable: false } };
    const controller = new AbortController(); requests.set(payload.id, controller);
    try { return { ok: true, texts: await engine.translate(payload, controller.signal) }; }
    catch (error) { return { ok: false, error: controller.signal.aborted ? { code: 'cancelled', message: '浏览器内置翻译已取消', retryable: false }
      : error instanceof ProviderError ? error.info : { code: 'no_provider', message: '浏览器内置模型当前不可用', retryable: true } }; }
    finally { if (requests.get(payload.id) === controller) requests.delete(payload.id); }
  };
}
window.addEventListener('pagehide', () => { for (const controller of requests.values()) controller.abort(); requests.clear(); engine.dispose(); });
