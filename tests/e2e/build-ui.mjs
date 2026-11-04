/**
 * 前端界面测试用的构建：内容脚本、设置页、PDF 阅读器、YouTube 脚本照常打包，后台换成假后端（src/dev/mock-backend.ts）。
 * 为什么不用 wxt build：正式后台是真后端，译文、服务列表、额度都不固定，界面测试没法断言；
 * 后台目录归后端，也不该为了测试在里面加分支。
 *
 *   node tests/e2e/build-ui.mjs                      # 产物：.output/ui-test
 *   EXT_DIR=.output/ui-test node tests/e2e/run.mjs
 *   EXT_DIR=.output/ui-test node tests/e2e/media.mjs
 *
 * 不加依赖：有 esbuild 就用 esbuild；没有就用 Vite 8 自带的 rolldown（node_modules 里已经有）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.resolve(process.env.OUT_DIR || path.join(root, '.output/ui-test'));
const tmp = path.join(out, '.entries');
rmSync(out, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// 两种打包器给同一个小接口：入口文件 → 单个输出文件（动态 import 内联进去）
const esbuild = await import('esbuild').catch(() => null);
const rolldown = esbuild ? null : await import('rolldown').catch(() => null);
if (!esbuild && !rolldown) throw new Error('找不到 esbuild 或 rolldown：先运行 npm i');
async function bundle(entry, outfile, format, banner) {
  if (esbuild) {
    await esbuild.build({ entryPoints: [entry], outfile, format, bundle: true, target: 'chrome120', logLevel: 'warning', banner: banner ? { js: banner } : undefined, tsconfig: path.join(root, 'typecheck/tsconfig.json') });
    return;
  }
  const b = await rolldown.rolldown({ input: entry, platform: 'browser', logLevel: 'warn' });
  await b.write({ file: outfile, format, banner, inlineDynamicImports: true });
  await b.close();
}

const src = (p) => path.join(root, 'src', p).replaceAll('\\', '/');
// WXT 的 defineContentScript / defineBackground 是构建时注入的全局函数，这里给个最简单的替身
const banner = 'globalThis.defineContentScript=d=>d;globalThis.defineBackground=f=>({main:f});';

const entries = {
  content: `import def from '${src('entrypoints/content')}';\n(def as any).main();\n`,
  'youtube-hook': `import def from '${src('entrypoints/youtube-hook.content')}';\n(def as any).main();\n`,
  youtube: `import def from '${src('entrypoints/youtube.content')}';\n(def as any).main();\n`,
  background: [
    `import { installMockBackend } from '${src('dev/mock-backend')}';`,
    'installMockBackend();',
    "chrome.action.onClicked.addListener((tab: any) => tab.id && chrome.tabs.sendMessage(tab.id, { cmd: 'toggle-page' }).catch(() => {}));",
    '',
  ].join('\n'),
};
for (const [name, code] of Object.entries(entries)) {
  const file = path.join(tmp, `${name}.ts`);
  writeFileSync(file, code);
  await bundle(file, path.join(out, `${name}.js`), 'iife', banner);
}

// 扩展页面：入口里有动态 import（先定界面语言再加载页面），用 esm
await bundle(src('entrypoints/options/main.ts'), path.join(out, 'options.js'), 'esm');
await bundle(src('entrypoints/pdf/main.ts'), path.join(out, 'pdf.js'), 'esm');
const page = (from, js) => readFileSync(path.join(root, 'src/entrypoints', from), 'utf8').replace(/<script type="module" src="\.\/main\.ts"><\/script>/, `<script type="module" src="./${js}"></script>`);
writeFileSync(path.join(out, 'options.html'), page('options/index.html', 'options.js'));
writeFileSync(path.join(out, 'pdf.html'), page('pdf/index.html', 'pdf.js'));

// pdf.js 的 worker、字体和 CMap
const pdfjs = path.join(root, 'node_modules/pdfjs-dist');
const assets = path.join(out, 'assets/pdf');
mkdirSync(assets, { recursive: true });
cpSync(path.join(pdfjs, 'build/pdf.worker.min.mjs'), path.join(assets, 'pdf.worker.min.mjs'));
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) if (existsSync(path.join(pdfjs, dir))) cpSync(path.join(pdfjs, dir), path.join(assets, dir), { recursive: true });

writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: '译（界面测试构建）',
  version: '0.0.0',
  permissions: ['storage', 'unlimitedStorage', 'contextMenus'],
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'background.js' },
  action: { default_title: '翻译本页' },
  options_ui: { page: 'options.html', open_in_tab: true },
  content_scripts: [
    { matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle' },
    { matches: ['*://www.youtube.com/*', 'http://127.0.0.1/*'], js: ['youtube-hook.js'], run_at: 'document_start', world: 'MAIN' },
    { matches: ['*://www.youtube.com/*', 'http://127.0.0.1/*'], js: ['youtube.js'], run_at: 'document_start' },
  ],
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'" },
  web_accessible_resources: [{ resources: ['pdf.html', 'assets/pdf/*'], matches: ['<all_urls>'] }],
  commands: { 'toggle-page': { suggested_key: { default: 'Alt+A' }, description: '翻译 / 还原本页' } },
}, null, 2));
rmSync(tmp, { recursive: true, force: true });
console.log(`界面测试构建（${esbuild ? 'esbuild' : 'rolldown'}）：` + path.relative(root, out));
