import { readdir, readFile, writeFile, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function filesWithin(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`发布目录不能包含符号链接：${name}`);
    if (entry.isDirectory()) result.push(...await filesWithin(directory, name));
    else if (entry.isFile()) result.push(name);
  }
  return result.sort();
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 两套 ONNX 版本不能互换；只有字节完全一致的构建器副本才重定向到各自原件。 */
export async function optimizeAssets(directory) {
  const root = path.resolve(directory);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('发布目录不能是符号链接');
  const files = await filesWithin(root);
  const originals = new Map();
  for (const name of files.filter((name) => /^assets\/(?:onnx|ocr-onnx)\/ort-wasm-[^/]+\.wasm$/.test(name))) {
    const bytes = await readFile(path.join(root, name));
    originals.set(sha256(bytes), name);
  }
  const replacements = new Map();
  let savedBytes = 0;
  for (const name of files.filter((name) => /^assets\/ort-wasm-[^/]+-[\w-]+\.wasm$/.test(name))) {
    const bytes = await readFile(path.join(root, name));
    const original = originals.get(sha256(bytes));
    if (original) { replacements.set(name, original); savedBytes += bytes.length; }
  }
  for (const name of files.filter((name) => /\.(?:js|mjs|css|html|json)$/.test(name))) {
    const filename = path.join(root, name);
    const before = await readFile(filename, 'utf8');
    let after = before;
    for (const [duplicate, original] of replacements) after = after.replaceAll(duplicate, original);
    if (after !== before) await writeFile(filename, after);
  }
  for (const duplicate of replacements.keys()) await unlink(path.join(root, duplicate));
  return { removed: [...replacements.keys()], savedBytes };
}

export async function writeIntegrity(directory) {
  const entries = {};
  for (const name of await filesWithin(directory)) {
    if (name === 'release-integrity.json') continue;
    const bytes = await readFile(path.join(directory, name));
    entries[name] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  await writeFile(path.join(directory, 'release-integrity.json'), JSON.stringify({ version: 1, files: entries }, null, 2) + '\n');
  return entries;
}

export async function verifyIntegrity(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'release-integrity.json'), 'utf8'));
  const actual = (await filesWithin(directory)).filter((name) => name !== 'release-integrity.json');
  if (manifest.version !== 1 || JSON.stringify(actual) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error('发布文件清单不一致');
  for (const name of actual) {
    const bytes = await readFile(path.join(directory, name));
    if (bytes.length !== manifest.files[name].bytes || sha256(bytes) !== manifest.files[name].sha256) throw new Error(`发布文件校验失败：${name}`);
  }
  return actual.length;
}
