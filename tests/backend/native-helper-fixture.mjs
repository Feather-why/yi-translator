import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const hostName = 'com.translate.local_model';
export const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
export const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
export function powershell(script, { cwd = root, input, args = [], timeout = 30000 } = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...(script ? ['-Command', script] : args)], { cwd, input, timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}
export async function createNativeFixture({ fakeModel = false, id = extensionId, nativeName = hostName } = {}) {
  if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(nativeName)) throw Error('Invalid fixture host name');
  // WScript.Shell 的快捷方式仍受传统路径长度影响；使用已允许的短临时目录。
  const parent = path.join(os.tmpdir(), 'translate-native-tests'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'fixture-'));
  const scripts = path.join(directory, 'gateway/scripts'), helper = path.join(directory, 'runtime/helper'), startup = path.join(directory, 'Startup');
  for (const folder of [scripts, helper, startup, path.join(directory, 'runtime/models'), path.join(directory, 'runtime/llama-b12069')]) await mkdir(folder, { recursive: true });
  const names = ['local-helper-common.ps1', 'native-host.ps1', 'install-helper.ps1', 'uninstall-helper.ps1', 'enable-autostart.ps1', 'disable-autostart.ps1'];
  for (const name of names) {
    const original = await readFile(path.join(root, 'gateway/scripts', name), 'utf8');
    const data = name === 'local-helper-common.ps1' ? original.replace("$script:LocalHelperName = 'com.translate.local_model'", `$script:LocalHelperName = '${nativeName}'`) : original;
    const extra = name === 'local-helper-common.ps1' ? `\nfunction Get-LocalStartupDirectory { return ${psQuote(startup)} }\n` : '';
    await writeFile(path.join(scripts, name), '\ufeff' + data.replace(/^\ufeff/, '') + extra);
  }
  await writeFile(path.join(directory, 'runtime/models/Hy-MT2-1.8B-Q4_K_M.gguf'), 'synthetic model fixture');
  const executable = path.join(directory, 'runtime/llama-b12069/llama-server.exe');
  if (fakeModel) {
    const compiled = powershell(`Add-Type -TypeDefinition 'using System; using System.Threading; public static class FixtureModel { public static void Main(string[] args) { Thread.Sleep(90000); } }' -OutputAssembly ${psQuote(executable)} -OutputType ConsoleApplication`);
    if (compiled.status !== 0) throw Error(compiled.stderr.toString());
  } else await writeFile(executable, 'fixture only; do not execute');
  const start = `param([switch]$Background)\n$ErrorActionPreference='Stop'\n$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\\..'))\n$exe=Join-Path $root 'runtime\\llama-b12069\\llama-server.exe'\n$child=Start-Process -FilePath $exe -WindowStyle Hidden -PassThru\n@{processId=$child.Id;startTimeUtc=$child.StartTime.ToUniversalTime().ToString('o');executable=$exe;port=8081}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'runtime\\local-model.state.json') -Encoding UTF8\nAdd-Content -LiteralPath (Join-Path $root 'starts.txt') -Value 'started'\nWrite-Host 'captured startup output, never native stdout'\n`;
  await writeFile(path.join(scripts, 'run-local.ps1'), '\ufeff' + start);
  const manifest = { name: nativeName, description: 'isolated native test', path: path.join(helper, 'native-host.cmd'), type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] };
  await writeFile(path.join(helper, nativeName + '.json'), JSON.stringify(manifest));
  await writeFile(path.join(helper, 'owner.json'), JSON.stringify({ name: nativeName, project: directory, version: 1 }));
  const origin = `chrome-extension://${id}/`, host = path.join(scripts, 'native-host.ps1'), common = path.join(scripts, 'local-helper-common.ps1');
  const stop = `. ${psQuote(common)}; if(Test-LocalRunning) { $state=Get-Content -LiteralPath ${psQuote(path.join(directory, 'runtime/local-model.state.json'))} -Raw -Encoding UTF8|ConvertFrom-Json; Stop-Process -Id $state.processId -Force }`;
  return { directory, parent, scripts, helper, startup, executable, common, host, origin, nativeName,
    stop() { const result = powershell(stop); if (result.status !== 0) throw Error(result.stderr.toString()); },
    async cleanup() { this.stop(); const absolute = path.resolve(directory); if (path.dirname(absolute) !== path.resolve(parent) || !path.basename(absolute).startsWith('fixture-')) throw Error('Refusing unexpected cleanup'); await rm(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
export function encodeNative(value) { const body = Buffer.from(JSON.stringify(value)); const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length); return Buffer.concat([prefix, body]); }
export function decodeNative(bytes) {
  const values = []; let offset = 0;
  while (offset < bytes.length) { if (offset + 4 > bytes.length) throw Error('partial prefix'); const size = bytes.readUInt32LE(offset); offset += 4; if (!size || size > 65536 || offset + size > bytes.length) throw Error('invalid body'); values.push(JSON.parse(bytes.subarray(offset, offset + size).toString('utf8'))); offset += size; }
  return values;
}
export function callNative(fixture, messages, origin = fixture.origin) {
  const input = Buffer.isBuffer(messages) ? messages : Buffer.concat(messages.map(encodeNative));
  const result = powershell(null, { input, args: ['-File', fixture.host, origin, '--parent-window=0'], timeout: 75000 });
  return { ...result, messages: decodeNative(result.stdout) };
}
