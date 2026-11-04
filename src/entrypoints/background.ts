/**
 * 后台 service worker 入口 —— 归后端（GPT）负责。
 *
 * 保留图标、快捷键与右键菜单的内容脚本命令转发。
 */
import { startBackend } from '../backend';
import { handleMediaMenu, installTranslationMenus } from '../backend/context-menu';
import { handleInstallation } from '../backend/installation';
import type { ContentCommand } from '../shared/protocol';

function sendToTab(tabId: number | undefined, cmd: ContentCommand) {
  if (tabId === undefined) return;
  chrome.tabs.sendMessage(tabId, cmd).catch(() => {
    /* 页面上没有内容脚本（chrome:// 页面、商店页等） */
  });
}

export default defineBackground(() => {
  const environment = (import.meta as ImportMeta & { env: { DEV: boolean; MODE: string } }).env;
  startBackend({ development: environment.DEV || environment.MODE === 'backend-test' });

  chrome.action.onClicked.addListener((tab) => sendToTab(tab.id, { cmd: 'toggle-page' }));

  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === 'toggle-page') sendToTab(tab?.id, { cmd: 'toggle-page' });
    else if (command === 'translate-selection') sendToTab(tab?.id, { cmd: 'translate-selection' });
  });

  chrome.runtime.onInstalled.addListener((details) => {
    void handleInstallation(details.reason, {
      installMenus: () => installTranslationMenus(chrome.contextMenus),
      getURL: (path) => chrome.runtime.getURL(path),
      open: (url) => chrome.tabs.create({ url }),
    });
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'tx-page') sendToTab(tab?.id, { cmd: 'toggle-page' });
    else void handleMediaMenu(info, tab, {
      send: (tabId, command, options) => chrome.tabs.sendMessage(tabId, command, options),
      open: (url) => chrome.tabs.create({ url }),
      getURL: (path) => chrome.runtime.getURL(path),
    });
  });
});
