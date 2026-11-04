/**
 * 译文里的链接是原链接的拷贝（href、target 都在），本身就能点。
 * 但单页应用（React Router 等）的路由监听挂在原链接上，直接点拷贝会整页刷新。
 * 这里把普通左键点击转发给原链接：原链接还在页面上时，用它的 click()，让站点自己处理。
 * 带修饰键（新标签页打开等）的点击保持浏览器默认行为。
 */
import { linkOrigin } from './serialize';

let installed = false;

export function installLinkForwarding(): void {
  if (installed) return;
  installed = true;
  document.addEventListener(
    'click',
    (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as Element | null;
      const a = t?.closest?.('tx-t a[data-tx-link]');
      if (!a) return;
      const orig = linkOrigin.get(a) as HTMLElement | undefined;
      if (!orig || !orig.isConnected) return;
      e.preventDefault();
      e.stopPropagation();
      orig.click();
    },
    true,
  );
}
