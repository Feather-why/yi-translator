import { verifyIntegrity } from './optimize-assets.mjs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const WASM_MAGIC = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

/** 检查实际交付目录，避免本机残留资源掩盖干净源码打包漏文件的问题。 */
export async function checkExtension(directory = path.join(projectRoot, '.output/chrome-mv3')) {
  const root = await realpath(path.resolve(directory));
  const checked = new Set();
  async function localFile(reference, relativeTo = 'manifest.json') {
    if (typeof reference !== 'string' || !reference || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(reference)) {
      throw new Error(`发布包不能引用远程或空路径：${String(reference)}`);
    }
    const pathname = decodeURIComponent(reference.split(/[?#]/, 1)[0]).replaceAll('\\', '/');
    const filename = path.resolve(pathname.startsWith('/') ? root : path.dirname(path.join(root, relativeTo)), '.' + (pathname.startsWith('/') ? pathname : '/' + pathname));
    const relative = path.relative(root, filename);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error(`发布包路径越界：${reference}`);
    let resolved;
    try { resolved = await realpath(filename); } catch { throw new Error(`发布包缺少文件：${relative}`); }
    const realRelative = path.relative(root, resolved);
    if (realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) throw new Error(`发布包文件指向目录外：${reference}`);
    const info = await stat(resolved);
    if (!info.isFile() || info.size === 0) throw new Error(`发布包文件为空或不是文件：${relative}`);
    checked.add(relative.replaceAll('\\', '/'));
    return { filename: resolved, relative: relative.replaceAll('\\', '/') };
  }
  async function readText(reference, relativeTo) {
    const file = await localFile(reference, relativeTo);
    return { ...file, text: await readFile(file.filename, 'utf8') };
  }
  async function readJson(reference) {
    const { text } = await readText(reference);
    try { return JSON.parse(text); } catch { throw new Error(`发布包 JSON 无效：${reference}`); }
  }
  async function wasm(reference) {
    const file = await localFile(reference);
    const body = await readFile(file.filename);
    if (body.length <= WASM_MAGIC.length || !body.subarray(0, WASM_MAGIC.length).equals(WASM_MAGIC)) throw new Error(`发布包 WASM 文件无效：${reference}`);
  }
  async function html(reference) {
    const page = await readText(reference);
    let scripts = 0;
    // 这里只读 HTML 的实际入口，不依赖构建器生成的 chunk 文件名或模块内部代码形状。
    for (const tag of page.text.matchAll(/<(script|link)\b([^>]*)>/gi)) {
      const attributes = Object.fromEntries([...tag[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4]]));
      if (tag[1].toLowerCase() === 'script' && attributes.src) {
        scripts++;
        await localFile(attributes.src, page.relative);
      } else if (tag[1].toLowerCase() === 'link' && /^(?:stylesheet|modulepreload|preload)$/i.test(attributes.rel ?? '') && attributes.href) {
        await localFile(attributes.href, page.relative);
      }
    }
    if (!scripts) throw new Error(`发布包页面没有脚本入口：${reference}`);
  }

  const manifest = await readJson('manifest.json');
  if (manifest.manifest_version !== 3 || typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version) || /^0(?:\.0){0,3}$/.test(manifest.version)) throw new Error('发布包必须是有正式版本号的 Manifest V3 扩展。');
  if (typeof manifest.name !== 'string' || /(?:界面测试|测试构建|\bmock\b|\bui-test\b|\bbackend-test\b)/i.test(manifest.name)) throw new Error('不能发布假后端或测试构建。');
  if (manifest.default_locale !== 'zh_CN') throw new Error('发布包缺少中文默认语言配置。');
  const messages = new Set([...JSON.stringify(manifest).matchAll(/__MSG_([^_][\w@]*)__/g)].map((m) => m[1]).filter((key) => !key.startsWith('@@')));
  if (!messages.size) throw new Error('发布包没有使用本地化名称与说明。');
  for (const locale of ['zh_CN', 'en']) {
    const catalog = await readJson(`_locales/${locale}/messages.json`);
    for (const key of messages) if (typeof catalog[key]?.message !== 'string' || !catalog[key].message.trim()) throw new Error(`发布包语言 ${locale} 缺少消息：${key}`);
    if (/(?:界面测试|测试构建|\bmock\b|\bui-test\b|\bbackend-test\b)/i.test(catalog.extensionName?.message ?? '')) throw new Error('不能发布假后端或测试构建。');
  }
  const background = await readText(manifest.background?.service_worker);
  // WXT 当前会保留 env 字面值；不能仅搜索 backend-test，因为正式代码也含比较字符串。
  for (const match of background.text.matchAll(/\bMODE\s*:\s*(["'`])([^"'`]+)\1/g)) if (match[2] !== 'production') throw new Error(`不能发布 ${match[2]} 模式的后台。`);
  if (!Array.isArray(manifest.content_scripts) || !manifest.content_scripts.length) throw new Error('发布包没有内容脚本。');
  for (const entry of manifest.content_scripts) {
    if (!Array.isArray(entry.js) || !entry.js.length) throw new Error('发布包内容脚本入口为空。');
    for (const reference of [...entry.js, ...(entry.css ?? [])]) await localFile(reference);
  }
  if (!manifest.options_ui?.page) throw new Error('发布包没有设置页入口。');
  const pages = new Set([manifest.options_ui.page, 'offscreen.html', 'pdf.html', 'ocr-sandbox.html', ...(manifest.sandbox?.pages ?? [])]);
  if (!(manifest.sandbox?.pages ?? []).includes('ocr-sandbox.html')) throw new Error('发布包没有注册 OCR 沙箱。');
  if (manifest.action?.default_popup) pages.add(manifest.action.default_popup);
  for (const page of pages) await html(page);
  for (const reference of [...Object.values(manifest.icons ?? {}), ...Object.values(typeof manifest.action?.default_icon === 'object' ? manifest.action.default_icon : {})]) await localFile(reference);
  if (typeof manifest.action?.default_icon === 'string') await localFile(manifest.action.default_icon);

  for (const directory of ['onnx', 'ocr-onnx']) {
    for (const stem of ['ort-wasm-simd-threaded', 'ort-wasm-simd-threaded.jsep']) {
      await localFile(`assets/${directory}/${stem}.mjs`);
      await wasm(`assets/${directory}/${stem}.wasm`);
    }
  }
  await localFile('assets/pdf/pdf.worker.min.mjs');
  for (const [directory, extension] of [['cmaps', '.bcmap'], ['standard_fonts', '.pfb'], ['wasm', '.wasm']]) {
    const files = await readdir(path.join(root, 'assets/pdf', directory)).catch(() => []);
    if (!files.some((name) => name.endsWith(extension))) throw new Error(`发布包缺少 PDF ${directory} 资源。`);
  }
  for (const reference of ['assets/pdf/cmaps/Adobe-Japan1-UCS2.bcmap', 'assets/pdf/standard_fonts/FoxitSerif.pfb', 'assets/pdf/standard_fonts/LiberationSans-Regular.ttf']) await localFile(reference);
  for (const name of ['openjpeg.wasm', 'qcms_bg.wasm', 'jbig2.wasm', 'quickjs-eval.wasm']) await wasm(`assets/pdf/wasm/${name}`);
  const build = await readJson('build-info.json');
  if (build.version !== manifest.version || typeof build.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(build.sourceDigest) || build.buildId !== `${build.version}-${build.sourceDigest.slice(0, 12)}` || !background.text.includes(build.buildId)) throw new Error('发布包构建编号或版本不一致');
  await verifyIntegrity(root);
  return { directory: root, version: manifest.version, buildId: build.buildId, checkedFiles: checked.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkExtension(process.argv[2]);
    console.log(`正式扩展检查通过：${result.version}，${result.checkedFiles} 个入口与关键资源（${result.directory}）。`);
  } catch (error) {
    console.error(`正式扩展检查失败：${error.message}`);
    process.exitCode = 1;
  }
}
