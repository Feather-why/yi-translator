import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sha256 } from './optimize-assets.mjs';
// 复用固定 WXT 构建依赖，不增加扩展的运行时依赖。
const require = createRequire(import.meta.resolve('wxt'));
const { createZip } = await import(pathToFileURL(require.resolve('@aklinker1/zero-zip')).href);
const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const names = ['setup-local.ps1', 'setup-common.ps1', 'local-downloads.json', 'run-local.ps1', 'start-local.cmd', 'stop-local.ps1', 'stop-local.cmd', 'local-helper-common.ps1', 'native-host.ps1', 'install-helper.ps1', 'install-helper.cmd', 'uninstall-helper.ps1', 'uninstall-helper.cmd', 'enable-autostart.ps1', 'enable-autostart.cmd', 'disable-autostart.ps1', 'disable-autostart.cmd'];
const zip = createZip({level:9});
const integrity = {};
function add(name, value) { const bytes=Buffer.isBuffer(value)?value:Buffer.from(value); zip.addFile(name,bytes); integrity[name]={bytes:bytes.length,sha256:sha256(bytes)}; }
for (const name of names) {
  let bytes=await readFile(path.join(root, 'gateway/scripts', name));
  // Windows PowerShell 5.1 依赖 BOM 识别脚本里的中文。
  if(name.endsWith('.ps1')) bytes=Buffer.from('\ufeff'+bytes.toString('utf8').replace(/^\ufeff/,''));
  add(`gateway/scripts/${name}`,bytes);
}
add('setup.cmd','@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0gateway\\scripts\\setup-local.ps1" %*\r\nset "yiExit=%ERRORLEVEL%"\r\nif not "%yiExit%"=="0" echo Setup failed. Check the message above.\r\npause\r\nexit /b %yiExit%\r\n');
add('LICENSE',await readFile(path.join(root,'LICENSE')));
add('README-local.txt','\ufeff'+await readFile(path.join(root,'docs/LOCAL-INSTALLER.md'),'utf8'));
add('PRIVACY.md',await readFile(path.join(root,'docs/PRIVACY.md')));
add('build-info.json',JSON.stringify({version:pkg.version,kind:'windows-x64-local-companion',runtime:'b12069'},null,2));
zip.addFile('release-integrity.json',JSON.stringify({version:1,files:integrity},null,2));
await mkdir(path.join(root,'.output'),{recursive:true});
const destination=path.join(root,'.output',`yi-local-setup-${pkg.version}-windows-x64.zip`);
const bytes=await zip.toBuffer();await writeFile(destination,bytes);
await writeFile(destination+'.sha256',sha256(bytes)+'  '+path.basename(destination)+'\n');
console.log(JSON.stringify({path:destination,bytes:bytes.length,sha256:sha256(bytes),files:Object.keys(integrity).length+1}));
