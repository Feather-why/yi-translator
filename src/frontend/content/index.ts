/** 内容脚本入口：把整页翻译、联动高亮、悬浮球、划词小窗接在一起。 */
import { isContentCommand } from '../../shared/rpc';
import { hostMatches, loadUiSettings, onUiSettingsChanged, saveUiSettings, type UiSettings } from '../../shared/settings';
import { Ball } from '../ui/ball';
import { UiHost } from '../ui/host';
import { SelectionUi } from '../ui/selection';
import { InputTranslator } from '../ui/input-translate';
import { showPdfBall } from '../ui/pdf-ball';
import { ImageTranslator } from '../media/images';
import { StatusFeed } from '../ui/status-feed';
import { ParaToolbar } from '../ui/toolbar';
import { rpc } from '../../shared/rpc';
import { LinkedHighlighter } from './highlight';
import { PageTranslator } from './page';
import { prefetchRule } from './rule-cache';
import { TranslateClient } from './port';
import { setUiLang } from '../i18n';

export async function startContent(): Promise<void> {
  if (window.top !== window) return; // M1 只处理顶层页面
  const w = window as unknown as { __txStarted?: boolean };
  if (w.__txStarted) return;
  w.__txStarted = true;
  if (document.contentType === 'application/pdf') {
    const s = await loadUiSettings();
    setUiLang(s.uiLang);
    return showPdfChip(s);
  }
  if (document.contentType && !/html/.test(document.contentType)) return;

  let settings: UiSettings = await loadUiSettings();
  setUiLang(settings.uiLang);
  const client = new TranslateClient();
  // 预热：唤醒后台、让后台叫醒本地模型、顺便查好这个网站的规则。同一页 60 秒内最多一次
  let lastWarm = 0;
  const warm = () => {
    const now = Date.now();
    if (now - lastWarm < 60_000 || client.dead) return;
    lastWarm = now;
    client.warm();
    rpc('providers:warm', { mode: settings.mode }).catch(() => {});
    if (!page.active) void prefetchRule(location.href);
  };
  const page = new PageTranslator(client, settings);
  const ui = new UiHost();
  const ball = new Ball(ui, settings, {
    toggle: () => void page.toggle(),
    setMode: (mode) => void saveUiSettings({ mode }),
    setDisplay: (display) => void saveUiSettings({ display }),
    retryErrors: () => page.retryErrors(),
    openSetup: () => void rpc('ui:openOptions', { tab: 'welcome' }).catch(() => {}),
    warm: () => warm(),
    setStyle: (txStyle) => void saveUiSettings({ txStyle }),
    setMainOnly: (mainOnly) => void saveUiSettings({ mainOnly }),
  });
  ui.setThemePreference(settings.theme);
  const selection = new SelectionUi(ui, client, settings);
  const inputs = new InputTranslator(ui, client, settings);
  const images = new ImageTranslator(ui, client, settings);
  let wasActive = false;
  const toolbar = new ParaToolbar(ui, page, new StatusFeed(), settings);
  const highlighter = new LinkedHighlighter(page);
  highlighter.start();

  page.onProgress = (p) => {
    ball.setProgress(p);
    if (p.active !== wasActive) {
      wasActive = p.active;
      images.setAuto(p.active); // 整页翻译时顺带翻译图片（需在设置里打开）
    }
  };
  client.onDead = () => ball.setDead();
  ball.setProgress(page.getProgress());

  onUiSettingsChanged((s) => {
    settings = s;
    ui.setThemePreference(s.theme);
    ball.apply(s);
    selection.apply(s);
    inputs.apply(s);
    images.apply(s);
    toolbar.apply(s);
    void page.updateSettings(s);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isContentCommand(msg)) return false;
    if (msg.cmd === 'toggle-page') void page.toggle();
    else if (msg.cmd === 'set-mode') void saveUiSettings({ mode: msg.mode });
    else if (msg.cmd === 'translate-selection') selection.openForSelection(msg.text);
    else if (msg.cmd === 'translate-image') images.translateBySrc(msg.srcUrl);
    else if (msg.cmd === 'align-reset') highlighter.reset();
    sendResponse({ ok: true });
    return false;
  });

  // 自动翻译：在「总是翻译」名单里、且不是敏感网站
  const host = location.hostname;
  if (hostMatches(host, settings.sites.always) && !hostMatches(host, settings.sites.never) && !hostMatches(host, settings.sensitive)) {
    void page.start();
  }
}

/**
 * 浏览器自带的 PDF 查看器：内容脚本读不到 PDF 里的选区，也改不了页面。
 * - 右下角两个入口：双栏对照翻译 / 单栏阅读（我们的阅读器，原文可以划词翻译，不整篇翻）；
 * - 在自带查看器里选中文字后右键「翻译」：后台把选中的文字发过来，这里直接开划词小窗。
 */
function showPdfChip(settings: UiSettings): void {
  const ui = new UiHost();
  ui.setAccent(settings.appearance.accent);
  const open = (view?: string) =>
    window.open(chrome.runtime.getURL('pdf.html') + '?url=' + encodeURIComponent(location.href) + (view ? `&view=${view}` : ''), '_blank');
  // 和网页上的悬浮球一样的小圆球：点一下双栏对照，悬停展开更多，可以拖动
  showPdfBall(ui, settings, open);

  // 右键菜单「翻译「…」」：后台带上选中的文字
  const selection = new SelectionUi(ui, new TranslateClient(), settings);
  onUiSettingsChanged((s) => selection.apply(s));
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isContentCommand(msg)) return false;
    if (msg.cmd === 'translate-selection' && msg.text) selection.openForText(msg.text);
    sendResponse({ ok: true });
    return false;
  });
}
