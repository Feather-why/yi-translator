/** 仅验证既有前端mock测试；不修改前端源码，也不覆盖正式扩展产物。 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'wxt';
import { chromium } from 'playwright';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';

const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const inside = (base, target) => { const relative = path.relative(base, target); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `测试路径必须位于 ${base}`); };
const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
const artifactRoot = path.join(work, 'frontend-mock-032'); await mkdir(artifactRoot, { recursive: true });
inside(root, await realpath(artifactRoot));
const output = await mkdtemp(path.join(artifactRoot, 'run-')), extension = path.join(output, 'extension'); inside(output, extension);
const profileRoot = path.join(output, 'profiles'); await mkdir(profileRoot); const profile = await mkdtemp(path.join(profileRoot, 'edge-'));
const report = { output, extension, browser: process.env.BROWSER_EXECUTABLE || 'playwright chromium', backend: undefined, transformedBackgrounds: 0, tests: [], exitCode: undefined };
async function treeHashes(directory) {
  const result = {};
  const visit = async base => { for (const entry of await readdir(base, { withFileTypes: true })) { const name = path.join(base, entry.name);
    if (entry.isDirectory()) await visit(name); else if (entry.isFile()) result[path.relative(directory, name).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(name)).digest('hex');
  } };
  try { await visit(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return result;
}
const watched = ['src/frontend', 'src/dev', 'tests/e2e', '.output/chrome-mv3'];
const before = Object.fromEntries(await Promise.all(watched.map(async folder => [folder, await treeHashes(path.join(root, folder))])));
const sourceFiles = ['src/entrypoints/background.ts', 'wxt.config.ts'];
const sourceBefore = await Promise.all(sourceFiles.map(file => readFile(path.join(root, file), 'utf8')));
let context, launchReplaced = false;
const launch = chromium.launchPersistentContext.bind(chromium), originalLog = console.log, originalExit = process.exit;
try {
  await build({ root, mode: 'frontend-mock-032', outDir: output, outDirTemplate: 'extension',
    vite: () => ({ plugins: [{ name: 'frontend-mock-032-only', enforce: 'pre', load(id) {
      if (id.startsWith('\0') || id.includes('?')) return;
      if (!id.replaceAll('\\', '/').endsWith('/src/entrypoints/background.ts')) return;
      const code = sourceBefore[0];
      const imported = "import { startBackend } from '../backend';";
      const start = "startBackend({ development: environment.DEV || environment.MODE === 'backend-test' });";
      assert.ok(code.includes(imported) && code.includes(start), '后台入口变化，拒绝猜测替换');
      report.transformedBackgrounds++;
      return { code: code.replace(imported, "import { installMockBackend } from '../dev/mock-backend';").replace(start, 'installMockBackend();'), map: null };
    } }] }),
  });
  assert.ok(report.transformedBackgrounds > 0, '独立构建必须实际接入既有mock');
  process.env.EXT_DIR = extension;
  chromium.launchPersistentContext = async (directory, options) => {
    assert.equal(directory, '', '原测试应请求临时浏览器资料夹');
    context = await launch(profile, { ...options, timeout: 60000,
      ...(process.env.BROWSER_EXECUTABLE ? { channel: undefined, executablePath: process.env.BROWSER_EXECUTABLE, ignoreDefaultArgs: ['--disable-extensions'] } : {}),
    });
    let [worker] = context.serviceWorkers(); worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(worker.url()).host;
    await isolateAutomaticWelcome(context, id);
    const check = await context.newPage(); await check.goto(`chrome-extension://${id}/options.html`);
    report.backend = await check.evaluate(() => chrome.runtime.sendMessage({ rpc: 'ping' })); await check.close();
    assert.equal(report.backend?.data?.backend, 'mock', '前端mock验收不能混入真后端/pseudo');
    return context;
  };
  launchReplaced = true;
  console.log = (...args) => { report.tests.push(args.map(String).join(' ')); originalLog(...args); };
  process.exit = (code = 0) => { report.exitCode = Number(code); process.exitCode = Number(code); };
  await import('../e2e/run.mjs');
} catch (error) {
  report.error = error.stack || String(error); report.exitCode = 1; process.exitCode = 1;
  originalLog(report.error);
} finally {
  console.log = originalLog; process.exit = originalExit;
  if (launchReplaced) chromium.launchPersistentContext = launch;
  await context?.close().catch(() => undefined);
  inside(await realpath(profileRoot), await realpath(profile));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => { report.retainedProfile = profile; });
  try {
    for (const folder of watched) assert.deepEqual(await treeHashes(path.join(root, folder)), before[folder], `测试期间不得改写 ${folder}`);
    assert.deepEqual(await Promise.all(sourceFiles.map(file => readFile(path.join(root, file), 'utf8'))), sourceBefore, '构建转换不得写回源码');
    report.sourceAndProductionUnchanged = true;
  } catch (error) { report.hashError = String(error); report.exitCode = 1; process.exitCode = 1; }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(output, 'frontend.log'), report.tests.join('\n') + '\n');
  originalLog('Frontend mock report:', path.join(output, 'report.json'));
}
