/** 导入已提交后使页面重新取对齐；不发送词典内容，受限页面和关闭的标签页互不影响。 */
export async function broadcastAlignmentReset(api: Pick<typeof chrome.tabs, 'query' | 'sendMessage'> = chrome.tabs): Promise<void> {
  try {
    const tabs = await api.query({});
    await Promise.allSettled(tabs.filter((tab) => Number.isInteger(tab.id) && tab.id! >= 0)
      .map(async (tab) => { await api.sendMessage(tab.id!, { cmd: 'align-reset' }); }));
  } catch { /* 广播失败不能把成功的词典导入报告成失败。 */ }
}
