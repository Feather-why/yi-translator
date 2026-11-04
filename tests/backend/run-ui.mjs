import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const self = fileURLToPath(import.meta.url);
const extension = path.join(root, '.output/ui-test');

function child(file, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, [file, ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
    processChild.once('error', reject);
    processChild.once('exit', (code) => resolve(code ?? 1));
  });
}

// 两个套件各用一个子进程，保留原测试的 process.exit 语义，失败时仍继续收集另一套结果。
if (process.argv[2] !== '--suite') {
  const built = await child(path.join(root, 'tests/e2e/build-ui.mjs'), [], { OUT_DIR: extension });
  if (built) process.exitCode = built;
  else {
    let failed = 0;
    for (const suite of ['run', 'media']) {
      const result = await child(self, ['--suite', suite]);
      if (result) failed = result;
    }
    process.exitCode = failed;
  }
} else {
  const suite = process.argv[3];
  if (!['run', 'media'].includes(suite)) throw new Error('未知界面测试套件');
  // 固定到刚构建的假后端，避免继承 EXT_DIR 后把 mock 断言套在正式包上。
  process.env.EXT_DIR = extension;
  const temporaryRoot = await realpath(os.tmpdir());
  const profile = await mkdtemp(path.join(temporaryRoot, 'translate-ui-browser-'));
  const originalLaunch = chromium.launchPersistentContext;
  const launch = originalLaunch.bind(chromium);
  const contexts = new Set();
  const exit = process.exit;
  let exitCode = 0;
  chromium.launchPersistentContext = async (directory, options) => {
    if (directory) throw new Error('界面测试只能使用本次创建的独立资料夹');
    const context = await launch(profile, {
      ...options,
      ...(process.env.BROWSER_EXECUTABLE ? { channel: undefined, executablePath: process.env.BROWSER_EXECUTABLE, ignoreDefaultArgs: ['--disable-extensions'] } : {}),
      timeout: 60000,
    });
    contexts.add(context);
    context.once('close', () => contexts.delete(context));
    return context;
  };
  // 原测试先关闭浏览器再 exit；暂存退出码，让包装器完成资料夹清理。
  process.exit = (code = 0) => { exitCode = Number(code); };
  try { await import(`../e2e/${suite}.mjs`); }
  catch (error) { console.error(error); exitCode = 1; }
  finally {
    process.exit = exit;
    chromium.launchPersistentContext = originalLaunch;
    for (const context of contexts) await context.close().catch(() => undefined);
    if (path.dirname(path.resolve(profile)) !== temporaryRoot || !path.basename(profile).startsWith('translate-ui-browser-')) throw new Error('拒绝清理未经验证的测试资料夹路径');
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }).catch((error) => {
      console.error('测试资料夹清理失败：', error.message);
      exitCode = 1;
    });
  }
  // 启动浏览器前失败时，原测试创建的 HTTP server 尚未进入 finally；子进程退出会一起回收。
  exit(exitCode);
}
