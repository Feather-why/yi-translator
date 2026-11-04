import { writeIntegrity } from '../../gateway/scripts/optimize-assets.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkExtension } from '../../gateway/scripts/check-extension.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'translate-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const put = async (name, body = 'fixture') => {
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  };
  const manifest = {
    manifest_version: 3, version: '0.2.10', name: '__MSG_extensionName__', description: '__MSG_extensionDescription__', default_locale: 'zh_CN',
    background: { service_worker: 'background.js' }, options_ui: { page: 'options.html' }, sandbox: { pages: ['ocr-sandbox.html'] },
    content_scripts: [{ matches: ['<all_urls>'], js: ['content-scripts/content.js'], css: ['content-scripts/content.css'] }],
  };
  const saveManifest = () => put('manifest.json', JSON.stringify(manifest));
  await saveManifest();
  for (const locale of ['en', 'zh_CN']) await put(`_locales/${locale}/messages.json`, JSON.stringify({ extensionName: { message: 'Yi' }, extensionDescription: { message: 'Local translation' } }));
  await put('background.js', 'const env = {MODE:`production`}; const development = env.MODE === `backend-test`; const buildId = "0.2.10-aaaaaaaaaaaa";');
  await put('build-info.json', JSON.stringify({ version: '0.2.10', sourceDigest: 'a'.repeat(64), buildId: '0.2.10-aaaaaaaaaaaa' }));
  await put('content-scripts/content.js', 'void 0;');
  await put('content-scripts/content.css', 'body{}');
  for (const name of ['options', 'offscreen', 'pdf', 'ocr-sandbox']) {
    await put(`${name}.html`, `<script type="module" src="/chunks/${name}-A1.js"></script><link rel="modulepreload" href="./chunks/shared-A1.js">`);
    await put(`chunks/${name}-A1.js`, 'void 0;');
  }
  await put('chunks/shared-A1.js', 'void 0;');
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 1, 0]);
  for (const family of ['onnx', 'ocr-onnx']) for (const suffix of ['', '.jsep']) {
    await put(`assets/${family}/ort-wasm-simd-threaded${suffix}.mjs`, 'export default {};');
    await put(`assets/${family}/ort-wasm-simd-threaded${suffix}.wasm`, wasm);
  }
  await put('assets/pdf/pdf.worker.min.mjs', 'export default {};');
  for (const name of ['openjpeg.wasm', 'qcms_bg.wasm', 'jbig2.wasm', 'quickjs-eval.wasm']) await put(`assets/pdf/wasm/${name}`, wasm);
  for (const name of ['cmaps/Adobe-Japan1-UCS2.bcmap', 'standard_fonts/FoxitSerif.pfb', 'standard_fonts/LiberationSans-Regular.ttf']) await put(`assets/pdf/${name}`);
  await writeIntegrity(directory);
  return { directory, put, manifest, saveManifest, remove: (name) => rm(path.join(directory, name)) };
}

test('发布检查接受生产包、带 hash 的入口和 production 中保留的测试模式比较字符串', async (t) => {
  const f = await fixture(t);
  assert.equal((await checkExtension(f.directory)).version, '0.2.10');
});

test('发布检查拒绝缺失的 PDF worker，防止未 prepare-assets 的 zip 混过', async (t) => {
  const f = await fixture(t);
  await f.remove('assets/pdf/pdf.worker.min.mjs');
  await assert.rejects(checkExtension(f.directory), /缺少文件.*pdf\.worker/);
});

test('发布检查拒绝遗漏或被错误下载内容替代的 OCR WASM', async (t) => {
  const f = await fixture(t);
  const filename = 'assets/ocr-onnx/ort-wasm-simd-threaded.wasm';
  await f.remove(filename);
  await assert.rejects(checkExtension(f.directory), /缺少文件.*ocr-onnx/);
  await f.put(filename, '<html>download error</html>');
  await assert.rejects(checkExtension(f.directory), /WASM 文件无效.*ocr-onnx/);
});

test('发布检查拒绝 HTML 指向的缺失入口 chunk', async (t) => {
  const f = await fixture(t);
  await f.remove('chunks/pdf-A1.js');
  await assert.rejects(checkExtension(f.directory), /缺少文件.*pdf-A1/);
});

test('发布检查拒绝远程页面脚本和越过交付目录的资源引用', async (t) => {
  const f = await fixture(t);
  await f.put('options.html', '<script src="https://example.test/remote.js"></script>');
  await assert.rejects(checkExtension(f.directory), /远程或空路径/);
  await f.put('options.html', '<script src="../outside.js"></script>');
  await assert.rejects(checkExtension(f.directory), /路径越界/);
});

test('发布检查拒绝丢失的英文消息，不让扩展管理页暴露占位符', async (t) => {
  const f = await fixture(t);
  await f.put('_locales/en/messages.json', '{"extensionName":{"message":"Yi"}}');
  await assert.rejects(checkExtension(f.directory), /语言 en 缺少消息：extensionDescription/);
});

test('发布检查拒绝假后端测试版本和 backend-test 构建', async (t) => {
  const f = await fixture(t);
  f.manifest.version = '0.0.0';
  await f.saveManifest();
  await assert.rejects(checkExtension(f.directory), /正式版本号/);
  f.manifest.version = '0.2.10';
  await f.saveManifest();
  await f.put('background.js', 'const env={MODE:`backend-test`};');
  await assert.rejects(checkExtension(f.directory), /不能发布 backend-test/);
});

test('发布检查拒绝伪装正式版本号的假后端名称和缺失的后台入口', async (t) => {
  const f = await fixture(t);
  f.manifest.name = '译（界面测试构建）';
  await f.saveManifest();
  await assert.rejects(checkExtension(f.directory), /假后端或测试构建/);
  f.manifest.name = '__MSG_extensionName__';
  await f.saveManifest();
  await f.remove('background.js');
  await assert.rejects(checkExtension(f.directory), /缺少文件.*background/);
});


test('发布检查拒绝构建编号混用和静默改写资源', async (t) => {
 const f=await fixture(t);
 await f.put('build-info.json', JSON.stringify({version:'0.2.11',sourceDigest:'a'.repeat(64),buildId:'0.2.11-aaaaaaaaaaaa'}));
 await assert.rejects(checkExtension(f.directory), /构建编号或版本/);
 const g=await fixture(t); await g.put('chunks/shared-A1.js','changed');
 await assert.rejects(checkExtension(g.directory), /发布文件校验失败/);
});
