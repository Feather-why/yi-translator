/** 复用语言包管理页，避免重复测试打断下载或制造多个准备窗口。 */
export interface BuiltinSetupTab { id?: number; url?: string; windowId: number }
export interface BuiltinSetupApi {
  runtime: { getURL(path: string): string };
  tabs: {
    query(query: { url: string }): Promise<BuiltinSetupTab[]>;
    create(properties: { url: string; active: true }): Promise<unknown>;
    update(id: number, properties: { active: true }): Promise<BuiltinSetupTab>;
  };
  windows: { update(id: number, properties: { focused: true }): Promise<unknown> };
}

export function createBuiltinSetupOpener(api?: BuiltinSetupApi): (sourceLang?: string, targetLang?: string) => Promise<void> {
  let opening: Promise<void> | undefined;
  const open = async (sourceLang?: string, targetLang?: string) => {
    // 保持窄接口，既支持独立测试，也不要求无依赖类型检查声明整个 windows API。
    const browser = api ?? chrome as unknown as BuiltinSetupApi;
    const base = browser.runtime.getURL('options.html');
    const query = sourceLang && targetLang ? '?' + new URLSearchParams({ sourceLang, targetLang }).toString() : '';
    const url = base + query + '#providers/browser-translator';
    const isSetup = (url?: string) => {
      if (!url) return false;
      const parsed = new URL(url);
      return parsed.protocol + '//' + parsed.host + parsed.pathname === base && parsed.hash === '#providers/browser-translator'
        && [...parsed.searchParams.keys()].every((key) => key === 'sourceLang' || key === 'targetLang');
    };
    const find = (tabs: BuiltinSetupTab[]) => tabs.find((tab) => isSetup(tab.url) && Number.isInteger(tab.id) && tab.id! >= 0);
    const activate = async (tab: BuiltinSetupTab) => {
      // 不传 url：正在下载的语言包和用户在卡片里选择的语言不能被导航清掉。
      const active = await browser.tabs.update(tab.id!, { active: true });
      await browser.windows.update(active.windowId, { focused: true });
    };
    const existing = find(await browser.tabs.query({ url: base + '*' }));
    if (existing) {
      try {
        await activate(existing);
        return;
      } catch (error) {
        // 查询后用户可能关页；只有确认旧页已消失才另开，普通聚焦失败不能制造副本。
        const remaining = await browser.tabs.query({ url: base + '*' });
        if (remaining.some((tab) => tab.id === existing.id && isSetup(tab.url))) throw error;
        const replacement = find(remaining);
        if (replacement) { await activate(replacement); return; }
      }
    }
    await browser.tabs.create({ url, active: true });
  };
  return (sourceLang, targetLang) => {
    // 整个查询/打开过程共用一次 Promise，失败也清理，下一次显式测试可以重试。
    if (!opening) opening = open(sourceLang, targetLang).finally(() => { opening = undefined; });
    return opening;
  };
}
