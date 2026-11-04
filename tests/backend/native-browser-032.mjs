import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, mkdtemp, readFile, writeFile, realpath, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createNativeFixture, powershell, psQuote, root } from './native-helper-fixture.mjs';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';

// 独立测试名称和临时Startup，始终不覆盖正式助手或日常模型。
const extension = path.resolve(process.env.EXT_DIR || path.join(root, '.output/chrome-mv3'));
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work/native-browser032'));
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json')));
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:\.\d+)?$/); assert.ok(manifest.permissions.includes('nativeMessaging'));
const temp = await realpath(os.tmpdir()), profile = await mkdtemp(path.join(temp, 'translate-native-browser-'));
await mkdir(output, { recursive: true });
let context, fixture, installed = false;
const report = { at: new Date().toISOString(), version: manifest.version, extension,
  packageHashes: Object.fromEntries(await Promise.all(['manifest.json', 'background.js'].map(async name => [name, createHash('sha256').update(await readFile(path.join(extension, name))).digest('hex')]))),
  payloads: [], cases: [], passed: false, testNativeName: `com.translate.local_model.test_032_${process.pid}` };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function checkedPs(script) {
  const result = powershell(script); assert.equal(result.status, 0, result.stderr.toString()); return result.stdout.toString('utf8').trim();
}
function snapshot() {
  return JSON.parse(checkedPs(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); . ${psQuote(fixture.common)};
    $state=$null; $stateFile=Join-Path (Get-LocalProjectRoot) 'runtime\\local-model.state.json'; if(Test-Path -LiteralPath $stateFile) { $state=Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8|ConvertFrom-Json };
    $nativeHosts=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains(${psQuote(fixture.host)}) });
    @{running=(Test-LocalRunning);nativeHosts=$nativeHosts.Count;state=$state;startup=@(Get-ChildItem -LiteralPath (Get-LocalStartupDirectory) -Filter '*.lnk'|ForEach-Object {$_.Name})}|ConvertTo-Json -Depth 6 -Compress`));
}
async function exitedHost() {
  let result;
  for (let attempt = 0; attempt < 8; attempt++) { result = snapshot(); if (result.nativeHosts === 0) return result; await pause(150); }
  assert.equal(result.nativeHosts, 0, '断开后native host应退出'); return result;
}
try {
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  let [worker] = context.serviceWorkers(); worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host; report.extensionId = id;
  await isolateAutomaticWelcome(context, id);
  const page = await context.newPage(); await page.goto(`chrome-extension://${id}/options.html#providers`);
  fixture = await createNativeFixture({ fakeModel: true, id, nativeName: report.testNativeName });
  const before = JSON.parse(checkedPs(`. ${psQuote(fixture.common)}; @{chrome=(Get-LocalRegistration 'Google\\Chrome');edge=(Get-LocalRegistration 'Microsoft\\Edge')}|ConvertTo-Json -Compress`));
  assert.deepEqual(before, { chrome: null, edge: null }, '不覆盖任何已有测试名注册');
  const installer = powershell(null, { args: ['-File', path.join(fixture.scripts, 'install-helper.ps1'), '-ExtensionId', id] });
  assert.equal(installer.status, 0, installer.stderr.toString()); installed = true;
  async function request(payload) {
    report.payloads.push(payload);
    const result = await page.evaluate(({ name, payload }) => new Promise(resolve => {
      const port = chrome.runtime.connectNative(name); let finished = false;
      const finish = result => { if (finished) return; finished = true; clearTimeout(timer); port.disconnect(); resolve(result); };
      const timer = setTimeout(() => finish({ failure: 'native timeout' }), 90000);
      port.onMessage.addListener(reply => finish({ reply }));
      port.onDisconnect.addListener(() => { const message = chrome.runtime.lastError?.message; if (!finished) finish({ failure: message || 'native disconnected without reply' }); });
      port.postMessage(payload);
    }), { name: fixture.nativeName, payload });
    assert.equal(result.failure, undefined, JSON.stringify(result)); return result.reply;
  }
  const initial = await request({ action: 'status' }); assert.equal(initial.ok, true); assert.equal(initial.data.supported, true); assert.equal(initial.data.enabled, false); assert.equal(initial.data.canStart, true);
  report.cases.push({ name: 'real-native-status', passed: true });
  const first = await request({ action: 'start' }); assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.data.ok, true);
  const afterFirst = await exitedHost(); assert.equal(afterFirst.running, true); assert.ok(afterFirst.state.processId); report.afterFirstDisconnect = afterFirst;
  report.cases.push({ name: 'cold-start-survives-native-disconnect', passed: true });
  const second = await request({ action: 'start' }); assert.equal(second.ok, true); assert.equal(second.data.ok, true);
  const afterSecond = await exitedHost(); assert.equal(afterSecond.running, true);
  assert.equal(afterSecond.state.processId, afterFirst.state.processId); assert.equal(afterSecond.state.startTimeUtc, afterFirst.state.startTimeUtc);
  assert.equal((await readFile(path.join(fixture.directory, 'starts.txt'), 'utf8')).trim().split(/\r?\n/).length, 1);
  report.cases.push({ name: 'second-start-reuses-process', passed: true });
  const enabled = await request({ action: 'autostart', enable: true }); assert.equal(enabled.ok, true, JSON.stringify(enabled)); assert.equal(enabled.data.enabled, true);
  const on = await request({ action: 'status' }); assert.equal(on.data.enabled, true); assert.equal((await readdir(fixture.startup)).filter(name => name.endsWith('.lnk')).length, 1);
  const disabled = await request({ action: 'autostart', enable: false }); assert.equal(disabled.ok, true); assert.equal(disabled.data.enabled, false); assert.equal((await readdir(fixture.startup)).length, 0);
  report.cases.push({ name: 'real-native-shortcut-toggle', passed: true });
  assert.ok(report.payloads.every(payload => Object.keys(payload).every(key => ['action', 'enable'].includes(key))));
  report.cases.push({ name: 'native-payload-has-no-webpage-content', passed: true });
  await context.close(); context = undefined;
  const afterBrowser = await exitedHost(); assert.equal(afterBrowser.running, true); assert.equal(afterBrowser.state.processId, afterFirst.state.processId); assert.equal(afterBrowser.state.startTimeUtc, afterFirst.state.startTimeUtc); report.afterBrowserClose = afterBrowser;
  report.cases.push({ name: 'model-survives-browser-close', passed: true });
  report.passed = true;
} catch (error) { report.failure = String(error?.stack || error); throw error; }
finally {
  if (context) await context.close();
  if (fixture) {
    try {
      if (installed) {
        const removed = powershell(null, { args: ['-File', path.join(fixture.scripts, 'uninstall-helper.ps1')] }); assert.equal(removed.status, 0, removed.stderr.toString());
        const remaining = JSON.parse(checkedPs(`. ${psQuote(fixture.common)}; @{chrome=(Get-LocalRegistration 'Google\\Chrome');edge=(Get-LocalRegistration 'Microsoft\\Edge')}|ConvertTo-Json -Compress`));
        assert.deepEqual(remaining, { chrome: null, edge: null }); report.testRegistrationRemoved = true;
      }
    } finally { await fixture.cleanup(); report.testProcessAndFilesRemoved = true; }
  }
  if (path.dirname(path.resolve(profile)) !== temp || !path.basename(profile).startsWith('translate-native-browser-')) throw Error('拒绝清理未知浏览器目录');
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, extensionId: report.extensionId, nativeName: report.testNativeName, report: path.join(output, 'report.json') }));
