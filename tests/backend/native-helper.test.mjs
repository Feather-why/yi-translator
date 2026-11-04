import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createNativeFixture, callNative, encodeNative, powershell, psQuote, extensionId } from './native-helper-fixture.mjs';
const windows = process.platform === 'win32';
async function fixture(t, options) { const value = await createNativeFixture(options); t.after(() => value.cleanup()); return value; }
function ps(f, body) { const result = powershell(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); . ${psQuote(f.common)}; ${body}`); assert.equal(result.status, 0, result.stderr.toString()); return result.stdout.toString('utf8').trim(); }
function fakeRegistry() { return `$script:Registrations=@{}; function Get-LocalRegistration([string]$Browser) { return $script:Registrations[$Browser] }; function Set-LocalRegistration([string]$Browser,[string]$Manifest) { if($script:FailEdge -and $Browser -eq 'Microsoft\\Edge') { $script:FailEdge=$false; throw 'injected write failure' }; $script:Registrations[$Browser]=$Manifest }; function Remove-LocalRegistration([string]$Browser) { $script:Registrations.Remove($Browser) };`; }

test('native: UTF8长度前缀与连续请求正确，stdout只有协议帧', { skip: !windows }, async t => {
  const f = await fixture(t); const result = callNative(f, [{ action: 'status' }, { action: 'status' }]);
  assert.equal(result.status, 0, result.stderr.toString()); assert.equal(result.messages.length, 2);
  for (const value of result.messages) assert.deepEqual(value, { ok: true, data: { enabled: false, canStart: true, supported: true } });
});
test('native: 不匹配或缺少的origin不返回状态', { skip: !windows }, async t => {
  const f = await fixture(t);
  for (const origin of ['chrome-extension://pppppppppppppppppppppppppppppppp/', 'https://example.invalid/', '']) {
    const result = callNative(f, [{ action: 'status' }], origin); assert.notEqual(result.status, 0); assert.equal(result.stdout.length, 0);
  }
});
test('native: 未知命令、任意路径/端口及错误enable类型都被拒绝', { skip: !windows }, async t => {
  const f = await fixture(t);
  const messages = [{ action: 'exec', command: 'ignored' }, { action: 'start', path: 'C:\\Windows' }, { action: 'start', port: 8082 }, { action: 'autostart', enable: 'true' }, { action: 'autostart' }, [], null, { Action: 'status' }];
  const result = callNative(f, messages); assert.equal(result.status, 0); assert.equal(result.messages.length, messages.length);
  for (const value of result.messages) { assert.equal(value.ok, false); assert.equal(value.error.code, 'bad_input'); assert.doesNotMatch(value.error.message, /C:|ignored/); }
});
test('native: 帧截断、零长度及超限会关闭连接，坏JSON仅返回固定错误', { skip: !windows }, async t => {
  const f = await fixture(t); const huge = Buffer.alloc(4); huge.writeUInt32LE(4097);
  for (const bytes of [Buffer.from([1, 0]), Buffer.alloc(4), huge, encodeNative({ action: 'status' }).subarray(0, 10)]) {
    const result = callNative(f, bytes); assert.notEqual(result.status, 0); assert.equal(result.stdout.length, 0);
  }
  const body = Buffer.from('{oops'), prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length);
  const result = callNative(f, Buffer.concat([prefix, body])); assert.equal(result.status, 0); assert.equal(result.messages[0].error.code, 'bad_input');
});
test('native: 实际隔离Startup链接启用/查询/停用幂等，其他文件保留', { skip: !windows }, async t => {
  const f = await fixture(t);
  const result = callNative(f, [{ action: 'autostart', enable: true }, { action: 'status' }, { action: 'autostart', enable: true }, { action: 'autostart', enable: false }, { action: 'status' }]);
  assert.equal(result.status, 0, result.stderr.toString()); assert.deepEqual(result.messages.map(x => x.data?.enabled), [true, true, true, false, false]);
  assert.equal(ps(f, `(Get-ChildItem -LiteralPath (Get-LocalStartupDirectory)).Count`), '0');
});
test('native: 不覆盖或删除同名非本项目启动项', { skip: !windows }, async t => {
  const f = await fixture(t);
  const result = JSON.parse(ps(f, `$shell=New-LocalShortcutShell; $link=$shell.CreateShortcut((Get-LocalLinkPath)); $link.TargetPath=Get-LocalPowerShell; $link.Arguments='-NoProfile'; $link.Save(); $errors=0; try { Set-LocalAutostart $true } catch { $errors++ }; try { Set-LocalAutostart $false } catch { $errors++ }; @{errors=$errors;exists=(Test-Path -LiteralPath (Get-LocalLinkPath));enabled=(Get-LocalAutostart)}|ConvertTo-Json -Compress`));
  assert.deepEqual(result, { errors: 2, enabled: false, exists: true });
});
test('native: 安装仅注册两浏览器且可重复，卸载只删自己的注册/文件', { skip: !windows }, async t => {
  const f = await fixture(t);
  const value = JSON.parse(ps(f, `${fakeRegistry()} $a=Install-LocalHelper @('${extensionId}'); $b=Install-LocalHelper @('${extensionId}'); $count=$script:Registrations.Count; $before=Get-LocalAutostart; $script:Registrations['Microsoft\\Edge']='C:\\foreign.json'; Uninstall-LocalHelper; @{count=$count;enabled=$before;left=$script:Registrations;manifestExists=(Test-Path -LiteralPath (Get-LocalHelperManifest));autostartChanged=$a.autostartChanged}|ConvertTo-Json -Compress`));
  assert.equal(value.count, 2); assert.equal(value.enabled, false); assert.equal(value.autostartChanged, false); assert.equal(value.manifestExists, false); assert.deepEqual(value.left, { 'Microsoft\\Edge': 'C:\\foreign.json' });
});
test('native: 注册部分失败回滚新文件和注册，不留下半安装', { skip: !windows }, async t => {
  const f = await fixture(t);
  const result = JSON.parse(ps(f, `${fakeRegistry()} Uninstall-LocalHelper; $script:FailEdge=$true; $failed=$false; try { Install-LocalHelper @('${extensionId}')|Out-Null } catch { $failed=$true }; @{failed=$failed;registrations=$script:Registrations.Count;manifestExists=(Test-Path -LiteralPath (Get-LocalHelperManifest));ownerExists=(Test-Path -LiteralPath (Join-Path (Get-LocalHelperDirectory) 'owner.json'))}|ConvertTo-Json -Compress`));
  assert.deepEqual(result, { failed: true, registrations: 0, manifestExists: false, ownerExists: false });
});
test('native: 重新安装失败恢复旧allowed_origins且拒绝外部注册冲突', { skip: !windows }, async t => {
  const f = await fixture(t);
  const result = JSON.parse(ps(f, `${fakeRegistry()} Install-LocalHelper @('${extensionId}')|Out-Null; $script:FailEdge=$true; try { Install-LocalHelper @('pppppppppppppppppppppppppppppppp')|Out-Null } catch {}; $m=Get-Content -LiteralPath (Get-LocalHelperManifest) -Raw -Encoding UTF8|ConvertFrom-Json; $script:Registrations['Google\\Chrome']='C:\\foreign.json'; $failed=$false; try { Install-LocalHelper @('${extensionId}')|Out-Null } catch { $failed=$true }; @{origins=$m.allowed_origins;failed=$failed;foreign=$script:Registrations['Google\\Chrome']}|ConvertTo-Json -Compress`));
  assert.deepEqual(result.origins, [f.origin]); assert.equal(result.failed, true); assert.equal(result.foreign, 'C:\\foreign.json');
});
test('native: 默认ID读取UTF8清单并采用Windows路径算法，已有key时按key计算', { skip: !windows }, async t => {
  const f = await fixture(t), extension = path.join(f.directory, '.output/chrome-mv3'); await mkdir(extension, { recursive: true });
  const toId = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + Number.parseInt(c, 16)));
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ name: '本机测试扩展', manifest_version: 3 }));
  assert.equal(ps(f, `Get-LocalExtensionId ${psQuote(extension)}`), toId(Buffer.from(extension.replace(/^[a-z]:/, m => m.toUpperCase()), 'utf16le')));
  const key = Buffer.from('synthetic public-key bytes'); await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ key: key.toString('base64') }));
  assert.equal(ps(f, `Get-LocalExtensionId ${psQuote(extension)}`), toId(key));
});
test('native: 缺少模型时canStart为false，不能伪报开机自启成功', { skip: !windows }, async t => {
  const f = await fixture(t); await unlink(f.executable);
  const result = callNative(f, [{ action: 'status' }, { action: 'autostart', enable: true }]);
  assert.equal(result.messages[0].data.canStart, false); assert.match(result.messages[0].data.hint, /部署/); assert.equal(result.messages[1].ok, false);
  assert.equal(ps(f, '(Get-ChildItem -LiteralPath (Get-LocalStartupDirectory)).Count'), '0');
});
test('native: 真实隔离进程启动幂等，host退出后进程继续存活且输出不污染帧', { skip: !windows }, async t => {
  const f = await fixture(t, { fakeModel: true });
  const first = callNative(f, [{ action: 'start' }]); assert.equal(first.status, 0, first.stderr.toString()); assert.equal(first.messages[0].data?.ok, true, JSON.stringify(first.messages));
  const one = JSON.parse((await readFile(path.join(f.directory, 'runtime/local-model.state.json'), 'utf8')).replace(/^\ufeff/, ''));
  assert.equal(ps(f, 'Test-LocalRunning'), 'True');
  const second = callNative(f, [{ action: 'start' }]); assert.equal(second.messages[0].data?.ok, true);
  const two = JSON.parse((await readFile(path.join(f.directory, 'runtime/local-model.state.json'), 'utf8')).replace(/^\ufeff/, ''));
  assert.equal(one.processId, two.processId); assert.equal(one.startTimeUtc, two.startTimeUtc);
  assert.equal((await readFile(path.join(f.directory, 'starts.txt'), 'utf8')).trim().split(/\r?\n/).length, 1);
});
