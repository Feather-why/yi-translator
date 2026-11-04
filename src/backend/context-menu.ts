import type { ContentCommand } from '../shared/protocol';

export const IMAGE_MENU_ID = 'tx-image';
export const PDF_LINK_MENU_ID = 'tx-pdf-link';
export const PDF_PAGE_MENU_ID = 'tx-pdf-page';
type MenuContext = 'selection' | 'page' | 'link' | 'image';
export interface MenuDefinition {
  id: string;
  title: string;
  contexts: MenuContext[];
  targetUrlPatterns?: string[];
  documentUrlPatterns?: string[];
}
export interface MenuClick {
  menuItemId: string | number;
  selectionText?: string;
  srcUrl?: string;
  linkUrl?: string;
  pageUrl?: string;
  frameUrl?: string;
  frameId?: number;
}
interface MenuTab { id?: number; url?: string }
export interface MediaMenuActions {
  send(tabId: number, command: ContentCommand, options: { frameId: number }): Promise<unknown>;
  open(url: string): Promise<unknown>;
  getURL(path: string): string;
  fetch?: typeof fetch;
}

// Chrome匹配模式区分路径大小写；点击时仍严格检查pathname，不靠星号判断文件类型。
const pdfPatterns = ['p', 'P'].flatMap((p) => ['d', 'D'].flatMap((d) => ['f', 'F'].map((f) => `*://*/*.${p}${d}${f}*`)));
const pdfPageRoutePatterns = ['*://arxiv.org/pdf/*', '*://export.arxiv.org/pdf/*'];
export function translationMenus(): MenuDefinition[] {
  return [
    { id: 'tx-selection', title: '翻译「%s」', contexts: ['selection'] },
    { id: 'tx-page', title: '翻译本页 / 还原', contexts: ['page'] },
    { id: IMAGE_MENU_ID, title: '翻译这张图片', contexts: ['image'] },
    // 两个过滤字段是不同上下文的限制，拆开以免HTML页面上的PDF链接被误隐藏。
    { id: PDF_LINK_MENU_ID, title: '用双栏阅读器打开', contexts: ['link'], targetUrlPatterns: [...pdfPatterns] },
    { id: PDF_PAGE_MENU_ID, title: '用双栏阅读器打开', contexts: ['page'], documentUrlPatterns: [...pdfPatterns, ...pdfPageRoutePatterns] },
  ];
}

export async function installTranslationMenus(api: { removeAll(): Promise<void>; create(definition: MenuDefinition): unknown }): Promise<void> {
  // 更新/重载时只重建本扩展自己的菜单，避免旧id残留和重复注册。
  await api.removeAll();
  for (const definition of translationMenus()) api.create(definition);
}

function parsedUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !value || value.length > 16 * 1024 * 1024 || /[\u0000-\u001f\u007f]/u.test(value)) return;
  try { return new URL(value); } catch { return; }
}
function webUrl(url: URL): boolean { return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }

export function imageResourceUrl(value: unknown): string | undefined {
  const url = parsedUrl(value);
  if (!url) return;
  if (webUrl(url)) return url.href;
  if (url.protocol === 'data:' && /^data:image\/[a-z0-9.+-]+(?:;[^,\r\n]*)?,/i.test(url.href)) return url.href;
  if (url.protocol === 'blob:') {
    const origin = parsedUrl(url.pathname);
    if (origin && webUrl(origin) && origin.pathname !== '/') return url.href;
  }
}

export function pdfResourceUrl(value: unknown): string | undefined {
  const url = parsedUrl(value);
  if (!url || !webUrl(url)) return;
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { return; }
  if (!pathname.toLowerCase().endsWith('.pdf')) return;
  return url.href;
}

function pdfPageRouteUrl(value: unknown): string | undefined {
  const url = parsedUrl(value);
  if (!url || !webUrl(url) || !['arxiv.org', 'export.arxiv.org'].includes(url.hostname)) return;
  if (!url.pathname.startsWith('/pdf/') || url.pathname.length <= '/pdf/'.length) return;
  return url.href;
}

async function verifyPdfRoute(source: string, fetcher: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // 仅在用户点击已知候选页后取文件头；服务器忽略Range时也不把整份论文读入内存。
    response = await fetcher(source, { method: 'GET', headers: { Range: 'bytes=0-4' }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
    if (!response.ok || response.redirected || !response.body) return false;
    reader = response.body.getReader();
    const magic = [0x25, 0x50, 0x44, 0x46, 0x2d];
    let received = 0;
    while (received < magic.length) {
      const { value, done } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) return false;
      for (let i = 0; i < value.length && received < magic.length; i++, received++) if (value[i] !== magic[received]) return false;
    }
    return true;
  } catch { return false; }
  finally {
    clearTimeout(timer);
    controller.abort();
    try {
      if (reader) await reader.cancel();
      else await response?.body?.cancel();
    } catch { /* 超时或连接结束后，取消流也可能拒绝；不再读取剩余响应。 */ }
  }
}

/** 仅消费浏览器提供的上下文；非法资源/标签页和没有接收者的页面均不产生额外动作。 */
export async function handleMediaMenu(info: MenuClick, tab: MenuTab | undefined, actions: MediaMenuActions): Promise<boolean> {
  try {
    if (info.menuItemId === 'tx-selection') {
      if (!Number.isInteger(tab?.id) || tab!.id! < 0) return false;
      // PDF查看器的选区不一定能从顶层DOM读取，随命令带上浏览器已取得的原文。
      await actions.send(tab!.id!, { cmd: 'translate-selection', text: info.selectionText }, { frameId: 0 });
      return true;
    }
    if (info.menuItemId === IMAGE_MENU_ID) {
      const source = imageResourceUrl(info.srcUrl);
      const frameId = info.frameId ?? 0;
      if (!source || !Number.isInteger(tab?.id) || tab!.id! < 0 || !Number.isInteger(frameId) || frameId < 0) return false;
      await actions.send(tab!.id!, { cmd: 'translate-image', srcUrl: source }, { frameId });
      return true;
    }
    let source: string | undefined;
    let needsProbe = false;
    if (info.menuItemId === PDF_LINK_MENU_ID) source = pdfResourceUrl(info.linkUrl);
    else if (info.menuItemId === PDF_PAGE_MENU_ID) {
      // iframe本身是PDF时优先取其地址；浏览器内置查看器的内部frame则退到原始页面地址。
      for (const value of [info.frameUrl, info.pageUrl, tab?.url]) {
        const direct = pdfResourceUrl(value), route = pdfPageRouteUrl(value);
        if (direct || route) { source = direct ?? route; needsProbe = !direct; break; }
      }
    }
    if (!source) return false;
    if (needsProbe && !await verifyPdfRoute(source, actions.fetch ?? globalThis.fetch)) return false;
    await actions.open(actions.getURL('pdf.html') + '?url=' + encodeURIComponent(source));
    return true;
  } catch {
    // 接收框架已导航/关闭时不重发给别的frame，也不把带令牌的源URL写入日志。
    return false;
  }
}
