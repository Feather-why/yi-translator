import { alignPairs, initializeAlignment } from './alignment';
import { registerMediaTasks } from './media';
import { registerBrowserTranslatorTasks } from './browser-translator';

/** 留出任务注册点，让 OCR 与词对齐共用唯一 offscreen 文档。 */
export const offscreenTasks: Record<string, (payload: any) => Promise<unknown>> = {
  'align:init': async () => { await initializeAlignment(); return { ready: true }; },
  'align:get': async (payload) => alignPairs(payload.pairs),
};
registerMediaTasks(offscreenTasks);
registerBrowserTranslatorTasks(offscreenTasks);

if (new URLSearchParams(location.search).get('translatorSetup') === '1') {
  // 准备页是可见 Window，不能同时抢答真正 offscreen 的内部消息。
  void import('./browser-translator-setup').then(({ mountBrowserTranslatorSetup }) => mountBrowserTranslatorSetup());
} else chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // 内部任务只能从后台/扩展页面进入，网页内容脚本走带隐私校验的业务 RPC。
  const internal = sender.url?.startsWith(chrome.runtime.getURL('')) || (!sender.url && !sender.tab);
  if (sender.id !== chrome.runtime.id || !internal) return false;
  if (!message || typeof message !== 'object' || !('target' in message) || message.target !== 'tx-offscreen' || !('task' in message) || typeof message.task !== 'string') return false;
  const task = Object.hasOwn(offscreenTasks, message.task) ? offscreenTasks[message.task] : undefined; if (!task) return false;
  void Promise.resolve().then(() => task('payload' in message ? message.payload : {})).then(
    (data) => sendResponse({ ok: true, data }),
    () => sendResponse({ ok: false, error: '本地推理任务失败，请检查模型下载和运行环境' }),
  );
  return true;
});
