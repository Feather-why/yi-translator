/** 仅供独立临时profile的专项测试使用；真首次引导专项不会调用此隔离。 */
export async function isolateAutomaticWelcome(context, extensionId) {
  const pending = new Set();
  const watch = (page) => {
    const closeIfAutomatic = () => {
      if (page.isClosed()) return;
      let url;
      try { url = new URL(page.url()); } catch { return; }
      if (url.protocol !== 'chrome-extension:' || url.hostname !== extensionId || url.pathname !== '/options.html' || !/^#welcome(?:[/?]|$)/.test(url.hash)) return;
      const closing = page.close().catch(() => undefined);
      pending.add(closing);
      void closing.finally(() => pending.delete(closing));
    };
    page.on('framenavigated', closeIfAutomatic);
    page.once('close', () => page.off('framenavigated', closeIfAutomatic));
    closeIfAutomatic();
  };
  context.on('page', watch);
  context.once('close', () => context.off('page', watch));
  for (const page of context.pages()) watch(page);
  await Promise.all([...pending]);
}
