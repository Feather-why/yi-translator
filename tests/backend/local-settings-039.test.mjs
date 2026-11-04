import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { createNativeFixture, encodeNative, decodeNative, powershell, psQuote, root } from './native-helper-fixture.mjs';

const windows = process.platform === 'win32';
async function fixture(t) { const f = await createNativeFixture(); t.after(() => f.cleanup()); return f; }
function ps(f, body, options = {}) {
  const result = powershell(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); . ${psQuote(f.common)}; ${body}`, options);
  assert.equal(result.status, 0, result.stderr.toString() + result.stdout.toString());
  return result.stdout.toString('utf8').trim();
}
const settingsPath = f => path.join(f.directory, 'runtime/local-model.settings.json');
const statePath = f => path.join(f.directory, 'runtime/local-model.state.json');
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\ufeff/, ''));
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port=server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function modelFixture(t) {
  const f = await fixture(t);
  for (const name of ['run-local.ps1', 'stop-local.ps1']) await writeFile(path.join(f.scripts, name), '\ufeff' + (await readFile(path.join(root, 'gateway/scripts', name), 'utf8')).replace(/^\ufeff/, ''));
  await unlink(f.executable);
  // 实际独立 Windows 进程和本机 HTTP；只模拟模型，不触碰用户 8081 服务或真实模型。
  const code = `using System; using System.IO; using System.Net; using System.Net.Sockets; using System.Text;
public static class FixtureModel { public static void Main(string[] args) {
  if(File.Exists("fail-start")) Environment.Exit(3);
  File.WriteAllLines("args.txt",args); int port=int.Parse(args[Array.IndexOf(args,"--port")+1]);
  var listener=new TcpListener(IPAddress.Loopback,port); listener.Start();
  while(true) { try { using(var client=listener.AcceptTcpClient()) using(var stream=client.GetStream()) { var b=new byte[4096]; if(stream.Read(b,0,b.Length)==0) continue; var response=Encoding.UTF8.GetBytes("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: 15\\r\\nConnection: close\\r\\n\\r\\n{\\"status\\":\\"ok\\"}"); stream.Write(response,0,response.Length); } } catch(IOException) {} }
} }`;
  const result=powershell(`Add-Type -TypeDefinition ${psQuote(code)} -OutputAssembly ${psQuote(f.executable)} -OutputType ConsoleApplication`);
  assert.equal(result.status,0,result.stderr.toString());
  f.stop=()=>{ const result=powershell(null,{args:['-File',path.join(f.scripts,'stop-local.ps1')]}); assert.equal(result.status,0,result.stderr.toString()); };
  f.run=(...args)=>{
    // Windows 子进程可能保留匿名管道句柄；测试把脚本输出写文件，只等待脚本本身退出。
    const stdout=path.join(f.directory,'run.stdout.log'), stderr=path.join(f.directory,'run.stderr.log');
    const out=openSync(stdout,'w'), err=openSync(stderr,'w');
    try {
      const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(f.scripts,'run-local.ps1'),'-Background',...args],{cwd:root,windowsHide:true,timeout:75000,stdio:['ignore',out,err]});
      if(result.error) throw result.error;
      return {...result,stdout:readFileSync(stdout),stderr:readFileSync(stderr)};
    } finally { closeSync(out); closeSync(err); }
  };
  f.startNative=async()=>{
    const input=path.join(f.directory,'native.input'),stdout=path.join(f.directory,'native.stdout'),stderr=path.join(f.directory,'native.stderr');
    await writeFile(input,encodeNative({action:'start'}));
    const fdIn=openSync(input,'r'),out=openSync(stdout,'w'),err=openSync(stderr,'w');
    try {
      const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',f.host,f.origin],{cwd:root,windowsHide:true,timeout:75000,stdio:[fdIn,out,err]});
      if(result.error) throw result.error;
      assert.equal(result.status,0,readFileSync(stderr,'utf8'));
      return decodeNative(readFileSync(stdout));
    } finally { closeSync(fdIn);closeSync(out);closeSync(err); }
  };
  return f;
}
test('local settings: 无配置时保留 8081 / GPU 六路 / 2048 默认，原快捷方式参数不变', {skip:!windows}, async t=>{
  const f=await fixture(t);
  assert.deepEqual(JSON.parse(ps(f,'Get-LocalModelSettings | ConvertTo-Json -Compress')),{version:1,cpu:false,port:8081,parallel:6,contextPerSlot:2048});
  assert.equal(ps(f,'Get-LocalRunArguments'),`-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.join(f.scripts,'run-local.ps1')}" -Background`);
});
test('local settings: 坏 JSON、额外命令路径、错误类型和越界不落回默认启动', {skip:!windows}, async t=>{
  const f=await fixture(t), valid={version:1,cpu:true,port:8082,parallel:2,contextPerSlot:1024};
  for(const value of ['{oops', '[]', 'x'.repeat(4097), JSON.stringify({...valid,path:'C:/Windows'}), JSON.stringify({...valid,cpu:'true'}), JSON.stringify({...valid,port:'8082'}), JSON.stringify({...valid,parallel:0}), JSON.stringify({...valid,contextPerSlot:8193})]) {
    await writeFile(settingsPath(f),value);
    assert.equal(ps(f,'try { $null=Get-LocalModelSettings; "accepted" } catch { "rejected" }'),'rejected');
    const state=JSON.parse(ps(f,'Get-LocalHelperStatus | ConvertTo-Json -Compress'));
    assert.equal(state.supported,true); assert.equal(state.canStart,false); assert.match(state.hint,/settings\.json/);
  }
});
test('local settings: 原子写入有界数据，非法新值保留旧文件', {skip:!windows}, async t=>{
  const f=await fixture(t);
  ps(f,'Save-LocalModelSettings $true 8082 3 1024');
  const before=await readFile(settingsPath(f),'utf8');
  assert.equal(ps(f,'try { Save-LocalModelSettings $false 80 6 2048; "accepted" } catch { "rejected" }'),'rejected');
  assert.equal(await readFile(settingsPath(f),'utf8'),before);
  ps(f,'Save-LocalModelSettings $false 8083 4 2048');
  assert.deepEqual(await readJson(settingsPath(f)),{version:1,cpu:false,port:8083,parallel:4,contextPerSlot:2048});
});
test('local settings: 手动 CPU 自定义端口成功后，停止、助手重启复用四个参数', {skip:!windows}, async t=>{
  const f=await modelFixture(t), port=await freePort();
  console.error('# local settings integration: manual start');
  const start=f.run('-Cpu','-Port',String(port),'-Parallel','3','-ContextPerSlot','1024');
  console.error('# local settings integration: manual start returned');
  assert.equal(start.status,0,start.stderr.toString()+start.stdout.toString());
  assert.deepEqual(await readJson(settingsPath(f)),{version:1,cpu:true,port,parallel:3,contextPerSlot:1024});
  const first=await readJson(statePath(f)), before=await readFile(path.join(path.dirname(f.executable),'args.txt'),'utf8');
  assert.equal(ps(f,'Test-LocalRunning'),'True');
  f.stop(); assert.deepEqual(await readJson(settingsPath(f)),{version:1,cpu:true,port,parallel:3,contextPerSlot:1024});
  console.error('# local settings integration: native restart');
  const next=await f.startNative(); assert.equal(next[0]?.data?.ok,true,JSON.stringify(next));
  console.error('# local settings integration: native restart returned');
  const second=await readJson(statePath(f)); assert.notEqual(first.processId,second.processId);
  assert.equal(await readFile(path.join(path.dirname(f.executable),'args.txt'),'utf8'),before);
  assert.equal(second.port,port); assert.equal(second.cpu,true); assert.equal(second.parallel,3); assert.equal(second.contextPerSlot,1024);
});
test('local settings: 进程启动失败不覆盖成功配置，不遗留管理状态', {skip:!windows}, async t=>{
  const f=await modelFixture(t), port=await freePort();
  ps(f,`Save-LocalModelSettings $true ${port} 2 1024`); const before=await readFile(settingsPath(f),'utf8');
  await writeFile(path.join(path.dirname(f.executable),'fail-start'),'fixture');
  const start=f.run('-Port',String(await freePort()),'-Parallel','4'); assert.notEqual(start.status,0);
  assert.equal(await readFile(settingsPath(f),'utf8'),before); await assert.rejects(readFile(statePath(f)),e=>e.code==='ENOENT');
});
test('local settings: 坏配置阻止默认启动，显式参数成功后修复', {skip:!windows}, async t=>{
  const f=await modelFixture(t), port=await freePort(); await writeFile(settingsPath(f),'{oops');
  const failed=f.run(); assert.notEqual(failed.status,0); await assert.rejects(readFile(statePath(f)),e=>e.code==='ENOENT');
  const fixed=f.run('-Cpu','-Port',String(port)); assert.equal(fixed.status,0,fixed.stderr.toString());
  assert.deepEqual(await readJson(settingsPath(f)),{version:1,cpu:true,port,parallel:2,contextPerSlot:2048});
});
test('local settings: 自定义模型路径仅手动使用，不能扩大助手启动路径权限', {skip:!windows}, async t=>{
  const f=await modelFixture(t), port=await freePort(), custom=path.join(f.directory,'runtime/models/custom.gguf');
  await writeFile(custom,'synthetic custom model'); ps(f,`Save-LocalModelSettings $true ${port} 2 1024`); const before=await readFile(settingsPath(f),'utf8');
  const started=f.run('-Port',String(port),'-ModelPath',custom); assert.equal(started.status,0,started.stderr.toString());
  assert.equal(await readFile(settingsPath(f),'utf8'),before); assert.match(started.stdout.toString(),/自定义模型/);
});
test('local settings: 仅换端口保留 CPU/并行/上下文，显式 Cpu 切换采用两路默认', {skip:!windows}, async t=>{
  const f=await modelFixture(t), port=await freePort();
  ps(f,`Save-LocalModelSettings $true ${await freePort()} 3 1024`);
  const moved=f.run('-Port',String(port)); assert.equal(moved.status,0,moved.stderr.toString());
  assert.deepEqual(await readJson(settingsPath(f)),{version:1,cpu:true,port,parallel:3,contextPerSlot:1024}); f.stop();
  ps(f,`Save-LocalModelSettings $false ${port} 6 1024`);
  const cpu=f.run('-Cpu'); assert.equal(cpu.status,0,cpu.stderr.toString());
  assert.deepEqual(await readJson(settingsPath(f)),{version:1,cpu:true,port,parallel:2,contextPerSlot:1024});
});
