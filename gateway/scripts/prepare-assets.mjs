import { mkdir, readdir, copyFile, cp, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const onnx = path.resolve(path.dirname(require.resolve('onnxruntime-web')), '..');
const target = path.join(root, 'public/assets/onnx');
await mkdir(target, { recursive: true });
const wasmFiles = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
// 旧版曾复制整个 dist；只清理该 SDK 自己的已知冗余产物。
for (const name of await readdir(target)) if (/^ort(?:\.[a-z]+)*\.mjs$/.test(name) && !wasmFiles.includes(name)) await unlink(path.join(target, name));
for (const name of wasmFiles) await copyFile(path.join(onnx, 'dist', name), path.join(target, name));
for (const name of ['LICENSE', 'ThirdPartyNotices.txt']) {
  try { await copyFile(path.join(onnx, name), path.join(target, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
console.log('已准备扩展本地 ONNX/WASM 运行文件。');
const paddleRequire = createRequire(fileURLToPath(import.meta.resolve('@paddleocr/paddleocr-js')));
const ocrOnnx = path.resolve(path.dirname(paddleRequire.resolve('onnxruntime-web')), '..');
const ocrTarget = path.join(root, 'public/assets/ocr-onnx');
await mkdir(ocrTarget, { recursive: true });
for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) await copyFile(path.join(ocrOnnx, 'dist', name), path.join(ocrTarget, name));
const pdfTarget = path.join(root, 'public/assets/pdf');
await mkdir(pdfTarget, { recursive: true });
await copyFile(path.join(path.dirname(require.resolve('pdfjs-dist')), 'pdf.worker.min.mjs'), path.join(pdfTarget, 'pdf.worker.min.mjs'));
for (const name of ['cmaps', 'standard_fonts', 'wasm']) await cp(path.join(path.resolve(path.dirname(require.resolve('pdfjs-dist')), '..'), name), path.join(pdfTarget, name), { recursive: true });
console.log('已准备 PaddleOCR 与 PDF.js 的本地运行文件。');
const licenses = path.join(root, 'public/licenses');
await mkdir(licenses, { recursive: true });
const transformers = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@huggingface/transformers'))), '..');
for (const [directory, prefix] of [[transformers, 'transformers'], [onnx, 'onnxruntime-web'], [ocrOnnx, 'ocr-onnxruntime-web'], [path.dirname(path.dirname(fileURLToPath(import.meta.resolve('@paddleocr/paddleocr-js')))), 'paddleocr'], [path.resolve(path.dirname(require.resolve('pdfjs-dist')), '..'), 'pdfjs']]) {
  for (const name of ['LICENSE', 'LICENSE.txt', 'ThirdPartyNotices.txt']) {
    try { await copyFile(path.join(directory, name), path.join(licenses, `${prefix}-${name}`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

await copyFile(path.join(root, 'LICENSE'), path.join(licenses, 'yi-LICENSE'));
await copyFile(path.join(root, 'docs/PRIVACY.md'), path.join(root, 'public/PRIVACY.md'));
