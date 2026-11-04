import { browserLanguage, type NativeDetectorApi, type NativeTranslatorApi } from '../../backend/browser-translator-engine';

/** 仅由用户在设置页明确点“测试”后打开；下载必须由本页真实按钮手势启动。 */
export function mountBrowserTranslatorSetup() {
  document.title = '准备浏览器内置翻译';
  const parameters = new URLSearchParams(location.search);
  let source = 'en', target = 'zh';
  try { source = browserLanguage(parameters.get('sourceLang') || 'en'); target = browserLanguage(parameters.get('targetLang') || 'zh'); } catch { /* 坏参数回到可编辑默认值，不执行任意地址。 */ }
  const style = document.createElement('style');
  style.textContent = 'body{font:16px/1.7 system-ui,sans-serif;max-width:720px;margin:56px auto;padding:0 24px;color:#172033;background:#f8fafc}main{padding:28px;background:white;border:1px solid #dfe5ed;border-radius:16px}h1{font-size:25px;margin-top:0}label{display:inline-flex;gap:8px;align-items:center;margin:8px 20px 8px 0}input{font:inherit;padding:6px 8px;width:90px;border:1px solid #b8c3d3;border-radius:6px}button{font:inherit;padding:9px 14px;border:0;border-radius:8px;background:#465ec8;color:white;cursor:pointer;margin:8px 8px 8px 0}button:disabled{opacity:.5;cursor:default}.secondary{background:#e9edf5;color:#29364e}progress{width:100%;height:14px}.note{color:#58677e}section{margin-top:22px;border-top:1px solid #e5eaf1;padding-top:16px}[role=status]{min-height:28px}';
  document.head.append(style);
  const main = document.createElement('main');
  main.innerHTML = '<h1>准备浏览器内置翻译</h1><p>首次使用需要下载浏览器提供的语言包。准备好后可在本机离线翻译，不消耗云端字符额度。</p><label>原文语言<input id="source" aria-label="原文语言代码"></label><label>译文语言<input id="target" aria-label="译文语言代码"></label><p class="note">语言代码示例：en 英语、zh 简体中文、zh-Hant 繁体中文、ja 日语。</p><section><h2>翻译语言包</h2><button id="prepare">下载并启用翻译语言包</button><progress id="translation-progress" max="1" value="0"></progress><p id="translation-status" role="status" aria-live="polite">尚未开始</p></section><section><h2>自动识别原文语言</h2><p>扩展会先用浏览器自带的 CLD 识别可靠的原文语言，无需下载检测模型。下面是可选的 AI 检测模型；设备不支持它也不影响已准备好的翻译语言包。不确定或混合语言会交给其他服务。</p><button id="detector">准备自动识别语言</button><progress id="detector-progress" max="1" value="0"></progress><p id="detector-status" role="status" aria-live="polite">尚未开始</p></section><button id="cancel" class="secondary">停止等待</button><p class="note">准备成功后可以关闭此页。未准备好的语言对会自动交给本地模型或其他可用服务；此页不会修改浏览器安全设置。</p>';
  document.body.replaceChildren(main);
  const sourceInput = main.querySelector<HTMLInputElement>('#source')!, targetInput = main.querySelector<HTMLInputElement>('#target')!;
  sourceInput.value = source; targetInput.value = target;
  const controllers = new Set<AbortController>();
  const hasExtensionDetection = typeof (globalThis as typeof globalThis & { chrome?: { i18n?: { detectLanguage?: unknown } } }).chrome?.i18n?.detectLanguage === 'function';
  const native = globalThis as typeof globalThis & { Translator?: NativeTranslatorApi; LanguageDetector?: NativeDetectorApi };
  const progressMonitor = (element: HTMLProgressElement) => (monitor: EventTarget) => monitor.addEventListener('downloadprogress', (event) => {
    const progress = event as ProgressEvent; const value = progress.total > 0 ? progress.loaded / progress.total : progress.loaded;
    if (Number.isFinite(value)) element.value = Math.max(0, Math.min(1, value));
  });
  const explain = (error: unknown) => error instanceof DOMException && error.name === 'NotAllowedError'
    ? '浏览器要求本页的实际点击操作，请重新点击按钮。'
    : error instanceof DOMException && error.name === 'AbortError' ? '已停止等待，可稍后重试。'
      : '浏览器暂时无法准备此模型，请检查网络及语言支持。其他翻译服务仍可使用。';
  const prepare = main.querySelector<HTMLButtonElement>('#prepare')!, translateStatus = main.querySelector<HTMLElement>('#translation-status')!, translateProgress = main.querySelector<HTMLProgressElement>('#translation-progress')!;
  prepare.addEventListener('click', async () => {
    if (!native.Translator) { translateStatus.textContent = '当前浏览器没有提供内置翻译 API，请使用本地模型。'; return; }
    let sourceLanguage: string, targetLanguage: string;
    try { sourceLanguage = browserLanguage(sourceInput.value); targetLanguage = browserLanguage(targetInput.value); } catch { translateStatus.textContent = '请输入有效的语言代码。'; return; }
    const controller = new AbortController(); controllers.add(controller); prepare.disabled = true; translateProgress.value = 0;
    translateStatus.textContent = '正在准备语言包，请保持本页打开……';
    try {
      // create 必须在点击处理器内先调用；不能先等一次网络或 RPC 再尝试激活。
      const creation = native.Translator.create({ sourceLanguage, targetLanguage, signal: controller.signal, monitor: progressMonitor(translateProgress) });
      const session = await creation; session.destroy(); translateProgress.value = 1;
      translateStatus.textContent = `翻译语言包已准备好（${sourceLanguage} → ${targetLanguage}）。`;
    } catch (error) { translateStatus.textContent = explain(error); }
    finally { controllers.delete(controller); prepare.disabled = false; }
  });
  const detectorButton = main.querySelector<HTMLButtonElement>('#detector')!, detectorStatus = main.querySelector<HTMLElement>('#detector-status')!, detectorProgress = main.querySelector<HTMLProgressElement>('#detector-progress')!;
  detectorButton.addEventListener('click', async () => {
    if (!native.LanguageDetector) { detectorStatus.textContent = hasExtensionDetection ? '此设备没有提供可选 AI 检测模型，扩展仍可使用 CLD 可靠识别。' : '当前浏览器没有提供语言检测能力，自动请求会使用其他服务。'; return; }
    const controller = new AbortController(); controllers.add(controller); detectorButton.disabled = true; detectorProgress.value = 0;
    detectorStatus.textContent = '正在准备自动语言检测，请保持本页打开……';
    try {
      const creation = native.LanguageDetector.create({ signal: controller.signal, monitor: progressMonitor(detectorProgress) });
      const detector = await creation; detector.destroy(); detectorProgress.value = 1; detectorStatus.textContent = '自动语言检测已准备好。';
    } catch (error) { detectorStatus.textContent = explain(error) + (hasExtensionDetection ? ' 扩展自带的 CLD 可靠识别仍可使用，无需等待这个可选模型。' : ''); }
    finally { controllers.delete(controller); detectorButton.disabled = false; }
  });
  main.querySelector('#cancel')!.addEventListener('click', () => { for (const controller of controllers) controller.abort(); });
  window.addEventListener('pagehide', () => { for (const controller of controllers) controller.abort(); });
}
