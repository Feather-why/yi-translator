import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { powershell, psQuote } from './native-helper-fixture.mjs';
import { sha256 } from '../../gateway/scripts/optimize-assets.mjs';
const require=createRequire(import.meta.resolve('wxt'));
const {createZip}=await import(pathToFileURL(require.resolve('@aklinker1/zero-zip')).href);
const root=fileURLToPath(new URL('../../',import.meta.url));
const win={skip:process.platform!=='win32'};
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'yi-setup-'));t.after(()=>rm(dir,{recursive:true,force:true}));const scripts=path.join(dir,'gateway/scripts');await mkdir(scripts,{recursive:true});for(const name of ['setup-local.ps1','setup-common.ps1']) await writeFile(path.join(scripts,name),'\ufeff'+(await readFile(path.join(root,'gateway/scripts',name),'utf8')).replace(/^\ufeff/,''));return {dir,scripts,common:path.join(scripts,'setup-common.ps1')};}
function run(f,body){return powershell(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); . ${psQuote(f.common)}; ${body}; exit 0`);}
test('独立安装工具：拒绝越界路径与压缩包，固定 CPU 模式不检测 GPU',win,async t=>{const f=await fixture(t);let result=run(f,`try { Assert-SetupPath ${psQuote(f.dir)} '..\\outside'; exit 5 } catch {}; if((Get-SetupMode -Cpu) -ne 'cpu'){exit 6}`);assert.equal(result.status,0,result.stderr.toString());const z=createZip();z.addFile('../escape.txt','bad');const zip=path.join(f.dir,'escape.zip');await writeFile(zip,await z.toBuffer());result=run(f,`try { Expand-SetupArchive ${psQuote(zip)} ${psQuote(path.join(f.dir,'unpack'))}; exit 5 } catch {}`);assert.equal(result.status,0);await assert.rejects(access(path.join(f.dir,'escape.txt')));});
test('独立安装工具：缓存按大小与 SHA 校验，错误正式缓存不覆盖',win,async t=>{const f=await fixture(t),cache=path.join(f.dir,'runtime/downloads');await mkdir(cache,{recursive:true});await writeFile(path.join(cache,'asset.zip'),'good');const asset=`@{name='asset.zip';url='https://github.com/example/release';bytes=4;sha256='${sha256(Buffer.from('good'))}'}`;let result=run(f,`$asset=${asset}; Get-SetupDownload ${psQuote(f.dir)} $asset`);assert.equal(result.status,0,result.stderr.toString());await writeFile(path.join(cache,'asset.zip'),'evil');result=run(f,`$asset=${asset}; try { Get-SetupDownload ${psQuote(f.dir)} $asset; exit 5 } catch {}`);assert.equal(result.status,0);assert.equal(await readFile(path.join(cache,'asset.zip'),'utf8'),'evil');});
test('独立安装工具：已校验离线夹具完成准备、健康检查后注册，PrepareOnly 不启动',win,async t=>{
 const f=await fixture(t),cache=path.join(f.dir,'runtime/downloads');await mkdir(cache,{recursive:true});
 const z=createZip();z.addFile('llama-server.exe','never executed fixture');const archive=await z.toBuffer(),model=Buffer.from('model fixture');
 const asset=(name,b)=>({name,url:'https://github.com/example/'+name,bytes:b.length,sha256:sha256(b)});
 const manifest={version:1,runtimeVersion:'b12069',model:asset('Hy-MT2-1.8B-Q4_K_M.gguf',model),cpu:asset('cpu.zip',archive)};
 await writeFile(path.join(cache,manifest.model.name),model);await writeFile(path.join(cache,'cpu.zip'),archive);await writeFile(path.join(f.scripts,'local-downloads.json'),JSON.stringify(manifest));
 await writeFile(path.join(f.scripts,'local-helper-common.ps1'),`function Get-LocalProjectRoot { return ${psQuote(f.dir)} }; function Get-LocalIdentity { return '${path.basename(f.dir)}' }; function Test-LocalRunning { return $false }; function Invoke-RestMethod { return @{status='ok'} }`);
 await writeFile(path.join(f.scripts,'run-local.ps1'),`param([switch]$Cpu,[int]$Port,[switch]$Background)\nAdd-Content -LiteralPath ${psQuote(path.join(f.dir,'trace.txt'))} -Value ('start:'+ $Cpu + ':' + $Port)`);
 await writeFile(path.join(f.scripts,'install-helper.ps1'),`param([string[]]$ExtensionId)\nAdd-Content -LiteralPath ${psQuote(path.join(f.dir,'trace.txt'))} -Value ('install:' + $ExtensionId[0])`);
 const setup=psQuote(path.join(f.scripts,'setup-local.ps1'));let result=run(f,`& ${setup} -Cpu -PrepareOnly`);assert.equal(result.status,0,result.stderr.toString());await assert.rejects(access(path.join(f.dir,'trace.txt')));
 result=run(f,`& ${setup} -Cpu -Port 18081 -ExtensionId aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);assert.equal(result.status,0,result.stderr.toString());assert.match(await readFile(path.join(f.dir,'trace.txt'),'utf8'),/start:True:18081\s+install:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
});

test('独立安装工具：无归属的断点保留；已完成的有归属断点无需网络即可恢复',win,async t=>{
 const f=await fixture(t),cache=path.join(f.dir,'runtime/downloads');await mkdir(cache,{recursive:true});
 const name='resume.zip',partial=path.join(cache,name+'.part'),metadata=partial+'.json',bytes=Buffer.from('complete fixture');
 const asset={name,url:'https://github.com/example/'+name,bytes:bytes.length,sha256:sha256(bytes)};
 await writeFile(partial,bytes);const args=`(ConvertFrom-Json ${psQuote(JSON.stringify(asset))})`;
 let result=run(f,`try { Get-SetupDownload ${psQuote(f.dir)} ${args}; exit 5 } catch {}`);assert.equal(result.status,0);assert.deepEqual(await readFile(partial),bytes);
 await writeFile(metadata,JSON.stringify({version:1,url:asset.url,bytes:asset.bytes,sha256:asset.sha256}));
 result=run(f,`Get-SetupDownload ${psQuote(f.dir)} ${args}`);assert.equal(result.status,0,result.stderr.toString());assert.deepEqual(await readFile(path.join(cache,name)),bytes);await assert.rejects(access(partial));await assert.rejects(access(metadata));
});
test('独立安装工具：替换保留旧运行库，新增用户文件时拒绝替换',win,async t=>{
 const f=await fixture(t),stage=path.join(f.dir,'runtime/stage-a');await mkdir(stage,{recursive:true});await writeFile(path.join(stage,'llama-server.exe'),'old bytes');
 let result=run(f,`Install-SetupRuntime ${psQuote(f.dir)} 'runtime/stage-a' 'cpu'`);assert.equal(result.status,0,result.stderr.toString());
 const next=path.join(f.dir,'runtime/stage-b');await mkdir(next);await writeFile(path.join(next,'llama-server.exe'),'new bytes');
 result=run(f,`Install-SetupRuntime ${psQuote(f.dir)} 'runtime/stage-b' 'cuda'`);assert.equal(result.status,0,result.stderr.toString());
 const {readdir}=await import('node:fs/promises');const backups=(await readdir(path.join(f.dir,'runtime'))).filter(name=>name.startsWith('previous-'));assert.equal(backups.length,1);assert.equal(await readFile(path.join(f.dir,'runtime',backups[0],'llama-server.exe'),'utf8'),'old bytes');
 const runtime=path.join(f.dir,'runtime/llama-b12069');await writeFile(path.join(runtime,'my-notes.txt'),'user content');
 result=run(f,`try { Assert-SetupManagedRuntime ${psQuote(f.dir)} 'runtime/llama-b12069'; exit 5 } catch {}`);assert.equal(result.status,0);assert.equal(await readFile(path.join(runtime,'my-notes.txt'),'utf8'),'user content');assert.equal(await readFile(path.join(runtime,'llama-server.exe'),'utf8'),'new bytes');
});
test('独立安装工具：解压中途失败仍保留现有运行库',win,async t=>{
 const f=await fixture(t),runtime=path.join(f.dir,'runtime/llama-b12069');await mkdir(runtime,{recursive:true});await writeFile(path.join(runtime,'llama-server.exe'),'existing');
 const z=createZip();z.addFile('llama-server.exe','new');z.addFile('../escape.txt','forbidden');const archive=path.join(f.dir,'mixed.zip');await writeFile(archive,await z.toBuffer());
 const result=run(f,`try { Expand-SetupArchive ${psQuote(archive)} ${psQuote(path.join(f.dir,'runtime/stage'))}; exit 5 } catch {}`);assert.equal(result.status,0);assert.equal(await readFile(path.join(runtime,'llama-server.exe'),'utf8'),'existing');await assert.rejects(access(path.join(f.dir,'runtime/escape.txt')));
});
test('独立安装 ZIP：目录越界、本地头名字不符和截断全部拒绝',async t=>{
 const {checkZip}=await import('../../gateway/scripts/check-zip.mjs');const dir=await mkdtemp(path.join(os.tmpdir(),'yi-zip-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const content=Buffer.from('hello');const manifest={version:1,files:{'hello.txt':{bytes:content.length,sha256:sha256(content)}}};
 const make=async extra=>{const z=createZip();z.addFile('hello.txt',content);z.addFile('release-integrity.json',JSON.stringify(manifest));if(extra)z.addFile(extra,'');return z.toBuffer();};
 const good=await make();const filename=path.join(dir,'fixture.zip');await writeFile(filename,good);assert.equal((await checkZip(filename)).checkedFiles,2);
 const mismatch=Buffer.from(good);mismatch.write('jello.txt',30,'utf8');await writeFile(filename,mismatch);await assert.rejects(checkZip(filename),/本地文件头与目录/);
 await writeFile(filename,await make('../outside/'));await assert.rejects(checkZip(filename),/路径/);
 await writeFile(filename,good.subarray(0,good.length-1));await assert.rejects(checkZip(filename),/中央目录/);
});

test('独立安装工具：新目录搬入失败时原子还原旧运行库',win,async t=>{
 const f=await fixture(t);const stageA=path.join(f.dir,'runtime/stage-a'),stageB=path.join(f.dir,'runtime/stage-b');
 await mkdir(stageA,{recursive:true});await mkdir(stageB);await writeFile(path.join(stageA,'llama-server.exe'),'old');await writeFile(path.join(stageB,'llama-server.exe'),'new');
 let result=run(f,`Install-SetupRuntime ${psQuote(f.dir)} 'runtime/stage-a' 'cpu'`);assert.equal(result.status,0,result.stderr.toString());
 result=run(f,`$script:originalCheck=(Get-Command Assert-SetupManagedRuntime).ScriptBlock; function Assert-SetupManagedRuntime([string]$Root,[string]$Relative) { & $script:originalCheck $Root $Relative; [IO.Directory]::Move(${psQuote(stageB)},${psQuote(stageB+'-away')}) }; try { Install-SetupRuntime ${psQuote(f.dir)} 'runtime/stage-b' 'cuda'; exit 5 } catch {}`);
 assert.equal(result.status,0,result.stderr.toString());assert.equal(await readFile(path.join(f.dir,'runtime/llama-b12069/llama-server.exe'),'utf8'),'old');
});
