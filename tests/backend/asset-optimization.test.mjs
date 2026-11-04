import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { optimizeAssets, writeIntegrity, verifyIntegrity } from '../../gateway/scripts/optimize-assets.mjs';

test('WASM 瘦身只复用同字节版本，并改写真实代码引用', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yi-assets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const part of ['assets/onnx', 'assets/ocr-onnx', 'chunks']) await mkdir(path.join(dir, part), { recursive: true });
  const a = 'assets/onnx/ort-wasm-simd-threaded.jsep.wasm';
  const b = 'assets/ocr-onnx/ort-wasm-simd-threaded.jsep.wasm';
  const dup = 'assets/ort-wasm-simd-threaded.jsep-hash123.wasm';
  const other = 'assets/ort-wasm-simd-threaded.jsep-new456.wasm';
  for (const [name, bytes] of [[a, 'version-A'], [b, 'version-B'], [dup, 'version-B'], [other, 'version-C']]) await writeFile(path.join(dir, name), bytes);
  await writeFile(path.join(dir, 'chunks/runtime.js'), `new URL('/${dup}',self.location.href); new URL('/${other}',self.location.href)`);
  const result = await optimizeAssets(dir);
  assert.deepEqual(result.removed, [dup]);
  assert.equal(result.savedBytes, 9);
  assert.match(await readFile(path.join(dir, 'chunks/runtime.js'), 'utf8'), /assets\/ocr-onnx\//);
  await assert.rejects(access(path.join(dir, dup)));
  await access(path.join(dir, other));
  await access(path.join(dir, a));
  assert.equal((await optimizeAssets(dir)).savedBytes, 0);
});

test('发布完整性检查能发现同名文件被改、缺失和额外文件', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yi-integrity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'background.js'), 'original');
  await writeIntegrity(dir);
  assert.equal(await verifyIntegrity(dir), 1);
  await writeFile(path.join(dir, 'background.js'), 'modified');
  await assert.rejects(verifyIntegrity(dir), /校验失败/);
  await writeFile(path.join(dir, 'background.js'), 'original');
  await writeFile(path.join(dir, 'untracked.js'), 'extra');
  await assert.rejects(verifyIntegrity(dir), /清单不一致/);
  await rm(path.join(dir, 'untracked.js'));
  await rm(path.join(dir, 'background.js'));
  await assert.rejects(verifyIntegrity(dir), /清单不一致/);
});
