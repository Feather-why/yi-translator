import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sourceFiles, packageSource } from '../../gateway/scripts/source-package.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yi-source-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const put = async (name, data = 'fixture') => { const file = path.join(dir, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, data); };
  await put('package.json', JSON.stringify({ name: 'fixture', version: '0.2.13' }));
  await put('.gitignore', 'node_modules/\n.output/\npublic/assets/\nruntime/\nwork/\n.idea/\n.env*\n!.env.example\n');
  return { dir, put };
}

test('源码导出遵守嵌套忽略规则，保留词典/许可证/示例配置，不初始化真实仓库', async t => {
  const f = await fixture(t);
  for (const name of ['src/main.ts', 'public/dict/words.json.gz', 'public/licenses/NOTICE', '.env.example', 'src/.gitignore']) await f.put(name, name === 'src/.gitignore' ? 'private.json\n' : 'public');
  for (const name of ['runtime/model.gguf', 'work/local.json', '.idea/workspace.xml', 'node_modules/a.js', 'public/assets/large.wasm', '.env', 'src/private.json']) await f.put(name, 'excluded');
  const files = await sourceFiles(f.dir);
  assert.ok(files.includes('public/dict/words.json.gz'));
  assert.ok(files.includes('public/licenses/NOTICE'));
  assert.ok(files.includes('.env.example'));
  assert.ok(!files.some(n => /private|workspace|large|node_modules|model\.gguf|local\.json/.test(n)));
  await assert.rejects(access(path.join(f.dir, '.git')));
});

test('忽略规则遗漏模型或环境密钥时源码导出停止，而不是悄悄上传', async t => {
  const f = await fixture(t);
  await f.put('.gitignore', '.output/\n');
  await f.put('.env.local', 'not-a-real-secret');
  await assert.rejects(sourceFiles(f.dir), /应忽略的本机文件/);
  await rm(path.join(f.dir, '.env.local'));
  await f.put('model.gguf', 'fixture');
  await assert.rejects(sourceFiles(f.dir), /应忽略的本机文件/);
});

test('源码包可重复生成且排除自身，拒绝覆盖目录和链接', async t => {
  const f = await fixture(t);
  await f.put('src/main.ts', 'export const version = 1;');
  const a = await packageSource(f.dir), b = await packageSource(f.dir);
  assert.equal(a.sourceFiles, 3);
  assert.equal(b.sourceFiles, a.sourceFiles);
  assert.ok(a.bytes > 0);
  assert.match(await readFile(a.file + '.sha256', 'utf8'), /^[a-f0-9]{64}  translate-ext-0\.2\.13-source\.zip\n$/);

  const checksum = a.file + '.sha256';
  const originalZip = await readFile(a.file), originalChecksum = await readFile(checksum);
  for (const filename of [a.file, checksum]) {
    await rm(filename);
    await mkdir(filename);
    await assert.rejects(packageSource(f.dir), /输出文件不能是链接或特殊文件/);
    const other = filename === a.file ? checksum : a.file;
    assert.deepEqual(await readFile(other), filename === a.file ? originalChecksum : originalZip, '发现任一非法目标前不能改写另一文件');
    await rm(filename, { recursive: true });
    await writeFile(filename, filename === a.file ? originalZip : originalChecksum);
  }

  const external = await fixture(t);
  await external.put('protected.txt', 'untouched');
  const protectedFile = path.join(external.dir, 'protected.txt');
  await rm(checksum);
  await link(protectedFile, checksum);
  await assert.rejects(packageSource(f.dir), /输出文件不能是链接或特殊文件/);
  assert.equal(await readFile(protectedFile, 'utf8'), 'untouched');
  assert.deepEqual(await readFile(a.file), originalZip, '校验文件为硬链接时也不能先改写 ZIP');
  await rm(checksum);
  await writeFile(checksum, originalChecksum);

  for (const filename of [a.file, checksum]) {
    await rm(filename);
    try {
      await symlink(protectedFile, filename, 'file');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      t.diagnostic('当前平台不允许创建文件符号链接；目录和硬链接防护已验证');
      await writeFile(filename, filename === a.file ? originalZip : originalChecksum);
      break;
    }
    await assert.rejects(packageSource(f.dir), /输出文件不能是链接或特殊文件/);
    assert.equal(await readFile(protectedFile, 'utf8'), 'untouched');
    const other = filename === a.file ? checksum : a.file;
    assert.deepEqual(await readFile(other), filename === a.file ? originalChecksum : originalZip);
    await rm(filename);
    await writeFile(filename, filename === a.file ? originalZip : originalChecksum);
  }

  const linkedOutput = await fixture(t);
  const destination = path.join(external.dir, 'protected-output');
  await mkdir(destination);
  await symlink(destination, path.join(linkedOutput.dir, '.output'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(packageSource(linkedOutput.dir), /输出目录不能是链接/);
  await assert.rejects(access(path.join(destination, path.basename(a.file))));
});
