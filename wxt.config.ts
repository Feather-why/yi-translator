import { defineConfig } from 'wxt';
import { prepareBuildInfo } from './gateway/scripts/build-info.mjs';
import { optimizeAssets, writeIntegrity } from './gateway/scripts/optimize-assets.mjs';

// 文档：https://wxt.dev/guide/essentials/config/manifest
export default defineConfig({
  srcDir: 'src',
  hooks: {
    'build:before': async (wxt) => { await prepareBuildInfo(wxt.config.root); },
    'build:done': async (wxt) => {
      const result = await optimizeAssets(wxt.config.outDir);
      await writeIntegrity(wxt.config.outDir);
      console.log(`WASM 复用节省 ${result.savedBytes} 字节（${result.removed.length} 个副本）。`);
    },
  },
  manifest: {
    default_locale: 'zh_CN',
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    permissions: ['storage', 'unlimitedStorage', 'contextMenus', 'offscreen', 'alarms', 'nativeMessaging'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'",
      sandbox: "sandbox allow-scripts; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self' blob:; connect-src https: http: chrome-extension: data:; img-src 'self' data: blob: https: http:",
    },
    sandbox: { pages: ['ocr-sandbox.html'] },
    web_accessible_resources: [
      { resources: ['assets/onnx/*', 'assets/ocr-onnx/*', 'assets/pdf/*'], matches: ['<all_urls>'] },
      // 浏览器自带的 PDF 查看器里，内容脚本用 window.open 打开双栏阅读器，需要它可被网页访问
      { resources: ['pdf.html'], matches: ['<all_urls>'] },
    ],
    // 后端要直接请求各家翻译接口与本地/远程模型，内容脚本也要注入所有页面。
    host_permissions: ['<all_urls>'],
    action: { default_title: '__MSG_actionTitle__' },
    commands: {
      'toggle-page': {
        suggested_key: { default: 'Alt+A' },
        description: '__MSG_togglePageDescription__',
      },
      'translate-selection': {
        suggested_key: { default: 'Alt+S' },
        description: '__MSG_translateSelectionDescription__',
      },
    },
  },
});
