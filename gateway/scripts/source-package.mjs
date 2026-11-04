import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const forbidden = /(?:^|\/)(?:node_modules|\.git|\.idea|\.wxt|\.output|runtime|work|models|\.venv)(?:\/|$)|^public\/assets\/|^tests\/\.compiled\/|\.(?:gguf|onnx|safetensors|log)$/i;

async function gitExecutable() {
  if (process.env.GIT_EXECUTABLE) return process.env.GIT_EXECUTABLE;
  if (process.platform === 'win32') {
    const candidate = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/cmd/git.exe');
    try { await access(candidate); return candidate; } catch { /* 其余安装方式由 PATH 定位 */ }
  }
  return 'git';
}

/** 临时 Git 元数据只用于解释 .gitignore；不初始化或改动用户的项目仓库。 */
export async function sourceFiles(directory) {
  const root = await realpath(directory);
  await access(path.join(root, '.gitignore'));
  const temporaryRoot = await realpath(os.tmpdir());
  const metadata = await mkdtemp(path.join(temporaryRoot, 'yi-source-index-'));
  const executable = await gitExecutable();
  const emptyConfig = path.join(metadata, 'empty-global-config');
  await writeFile(emptyConfig, '');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  const run = args => execFileSync(executable, args, { cwd: root, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  try {
    run(['-c', 'init.templateDir=', 'init', '--bare', '--quiet', metadata]);
    const listed = run(['--git-dir', metadata, '--work-tree', root, '-c', `core.excludesFile=${emptyConfig}`, 'ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean);
    const entries = [];
    for (const name of listed.sort()) {
      if (name === 'SOURCE-MANIFEST.json') continue;
      const base = path.posix.basename(name);
      if (forbidden.test(name) || (/^\.env(?:\.|$)/.test(base) && base !== '.env.example')) throw new Error(`源码包包含应忽略的本机文件，请修正 .gitignore：${name}`);
      const filename = path.resolve(root, name);
      const relative = path.relative(root, filename);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || name.includes('\\')) throw new Error('源码路径超出项目目录');
      const info = await lstat(filename);
      const actual = await realpath(filename);
      const resolvedRelative = path.relative(root, actual);
      if (!info.isFile() || info.isSymbolicLink() || resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) throw new Error(`源码包不接受链接或特殊文件：${name}`);
      if (info.size > 100 * 1024 * 1024) throw new Error(`源码文件超过 100 MiB：${name}`);
      entries.push(name);
    }
    return entries;
  } finally {
    if (path.dirname(metadata) !== temporaryRoot || !path.basename(metadata).startsWith('yi-source-index-')) throw new Error('临时 Git 目录不在预期位置');
    await rm(metadata, { recursive: true, force: true });
  }
}

async function validateOutputFile(filename) {
  try {
    const info = await lstat(filename);
    // 普通覆盖也会跟随文件链接；两个目标都须先检查，避免只更新了其中一个。
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error(`输出文件不能是链接或特殊文件：${path.basename(filename)}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function packageSource(directory = projectRoot) {
  const root = await realpath(directory);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error('源码版本号无效');
  const require = createRequire(import.meta.resolve('wxt'));
  const { createZip } = await import(pathToFileURL(require.resolve('@aklinker1/zero-zip')).href);
  const archive = createZip({ level: 9 });
  const entries = [];
  for (const name of await sourceFiles(root)) {
    const bytes = await readFile(path.join(root, name));
    entries.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    archive.addFile(name, bytes);
  }
  const manifest = { format: 1, version: pkg.version, files: entries };
  archive.addFile('SOURCE-MANIFEST.json', JSON.stringify(manifest, null, 2) + '\n');
  const output = path.join(root, '.output');
  await mkdir(output, { recursive: true });
  if ((await lstat(output)).isSymbolicLink()) throw new Error('输出目录不能是链接');
  const filename = path.join(output, `translate-ext-${pkg.version}-source.zip`);
  await validateOutputFile(filename);
  await validateOutputFile(filename + '.sha256');
  const bytes = await archive.toBuffer();
  await writeFile(filename, bytes);
  const digest = sha256(bytes);
  await writeFile(filename + '.sha256', `${digest}  ${path.basename(filename)}\n`);
  return { file: filename, bytes: bytes.length, sha256: digest, sourceFiles: entries.length, uncompressedBytes: entries.reduce((n, e) => n + e.bytes, 0) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await packageSource(), null, 2));
