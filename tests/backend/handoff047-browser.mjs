import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { access, readFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';

// 正式包、状态端口、服务保存、内容脚本均真实；模型只使用本机 HTTP 回放，不下载/调用云服务。
const root = fileURLToPath(new URL('../../', import.meta.url));
const extension = path.resolve(process.env.EXT_DIR || path.join(root, '.output/chrome-mv3'));
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work/handoff047-browser'));
await access(path.join(extension, 'manifest.json'));
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.version, version);
await mkdir(output, { recursive: true });
const tempRoot = await realpath(os.tmpdir());
const profile = await mkdtemp(path.join(tempRoot, 'translate-handoff047-'));
const fixture = await readFile(path.join(root, 'tests/e2e/fixtures/layouts.html'));
const translations = new Map([
  ['Hello.', '你好。'], ['Guides', '指南'], ['API Reference', '接口参考'], ['Released Notes', '发布说明'],
  ['Short label text for this row', '这一行的简短标签'], ['History', '历史'],
  ['Humans are the most abundant and widespread species of primates, characterized by bipedalism and large complex brains.', '人类是数量最多、分布最广的灵长类物种，具有直立行走和复杂大脑的特征。'],
  ['The tall box sits next to the label and is much taller than it.', '高框在标签旁边，比标签高得多。'],
  ['Hominoidea (hominoids, apes)', '人猿总科'], ['Hylobatidae (gibbons)', '长臂猿科'], ['Hominidae (hominids, great apes)', '人科'],
  ['Contents of the article and its sections', '文章目录'], ['Appearance settings for this page', '页面外观设置'],
  ['Human', '人类'], ['Temporal range:', '生存年代：'], ['million years ago', '百万年前'],
  ['Chibanian', '千叶期'], ['present day', '现在'], ['The history of the species is long and interesting for many reasons.', '这个物种的历史悠久而有趣。'],
]);
const requests = [], failures = [], errors = [];
let healthChecks = 0, context;
const report = { at: new Date().toISOString(), version, extension, backend: 'production', model: 'local HTTP playback', cases: [] };
function translated(source) {
  if (translations.has(source.trim())) return translations.get(source.trim());
  // 图表正文只验证布局与原占位符保留，未列入精确词表的文本叶子使用确定性中文回放。
  return source.split(/(<\/?g\d+>|<x\d+\/>|\[TXP\d+_\d+\])/g).map(part => {
    if (!/[a-z]/i.test(part) || /^(?:<\/?g\d+>|<x\d+\/>|\[TXP\d+_\d+\])$/.test(part)) return part;
    return translations.get(part.trim()) ?? '版面测试译文';
  }).join('');
}
const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/layouts.html') { response.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' }).end(fixture); return; }
    if (request.method === 'GET' && request.url === '/health') { healthChecks++; response.writeHead(200, { 'Content-Type':'application/json' }).end('{"status":"ok"}'); return; }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let body=''; for await (const chunk of request) body += chunk;
    const input=JSON.parse(body), prompt=input.messages?.[0]?.content;
    assert.equal(typeof prompt, 'string');
    const marker=prompt.match(/(?:只输出译文：|不要额外解释：)\n/);
    assert.ok(marker, '回放只接受真实翻译模板');
    const source=prompt.slice(marker.index+marker[0].length), text=translated(source);
    assert.ok(text.trim()); requests.push({ source, text, stream:input.stream, cookie:request.headers.cookie });
    if(input.stream) {
      response.writeHead(200, { 'Content-Type':'text/event-stream' });
      response.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:text},finish_reason:null}]})+'\n\n');
      response.end('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    } else response.writeHead(200, { 'Content-Type':'application/json' }).end(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}]}));
  } catch(error) { failures.push(String(error.stack||error)); response.writeHead(500).end('{"error":"fixture failure"}'); }
});
await new Promise((resolve,reject) => { server.once('error',reject);server.listen(0,'127.0.0.1',resolve); });
const address=`http://127.0.0.1:${server.address().port}`;
async function rpc(page,name,payload) {
  const response=await page.evaluate(({name,payload})=>chrome.runtime.sendMessage({rpc:name,payload}),{name,payload});
  assert.equal(response?.ok,true,JSON.stringify(response));return response.data;
}
async function snapshot(page) {
  return page.evaluate(()=>new Promise((resolve,reject)=>{
    const port=chrome.runtime.connect({name:'tx:status'});
    const timer=setTimeout(()=>{port.disconnect();reject(Error('snapshot timeout'));},5000);
    port.onMessage.addListener(message=>{if(message.type==='snapshot'){clearTimeout(timer);port.disconnect();resolve(message.status);}});
  }));
}
try {
  context=await chromium.launchPersistentContext(profile,{headless:process.env.HEADED!=='1',viewport:{width:1360,height:1100},
    executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  await context.route(/^https?:\/\//,route => new URL(route.request().url()).origin===address ? route.continue() : route.abort());
  let [worker]=context.serviceWorkers();worker ||= await context.waitForEvent('serviceworker',{timeout:15000});
  const id=new URL(worker.url()).host, base=`chrome-extension://${id}/options.html`;
  await isolateAutomaticWelcome(context,id);
  await worker.evaluate(async()=>{const old=await chrome.storage.local.get('settings.ui');await chrome.storage.local.set({'settings.ui':{...old['settings.ui'],onboarded:true,uiLang:'zh-CN',sourceLang:'en',targetLang:'zh-CN',mode:'fast',mainOnly:false,txStyle:'bar',loadingEffect:'dots'}});});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'#providers');
  assert.equal((await rpc(page,'ping')).backend,`${version}-release`);
  const providers=await rpc(page,'providers:list');assert.ok(!providers.some(p=>p.id==='pseudo'));
  for(const p of providers) await rpc(page,'providers:save',{id:p.id,enabled:false,config:p.config});
  await rpc(page,'providers:save',{id:'llamacpp',enabled:true,config:{url:address}});
  const microsoft=providers.find(p=>p.id==='microsoft');assert.ok(microsoft);
  await rpc(page,'providers:save',{id:microsoft.id,enabled:true,config:microsoft.config});
  assert.equal((await rpc(page,'providers:test',{id:'llamacpp'})).ok,true);
  const before=await snapshot(page),local=before.providers.find(p=>p.id==='llamacpp');
  assert.ok(local.rank>0,'真实快照需含快速档排名，才能证明精确表主动隐藏它');
  report.fastRank=local.rank;
  await page.goto(base+'#status');
  const rows=page.locator('table tbody tr');
  await rows.filter({hasText:microsoft.name}).first().waitFor();
  assert.ok(await rows.filter({hasText:local.name}).count());
  await page.goto(base+'#providers/microsoft');
  await page.getByRole('switch',{name:'启用',exact:true}).uncheck();
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.waitForFunction(async()=>{const r=await chrome.runtime.sendMessage({rpc:'providers:list'});return r.ok && r.data.find(p=>p.id==='microsoft')?.enabled===false;});
  await page.goto(base+'#status');
  await rows.filter({hasText:local.name}).first().waitFor();
  assert.equal(await rows.filter({hasText:microsoft.name}).count(),0);
  const live=await snapshot(page),enabledNames=new Set(live.providers.filter(p=>p.enabled).map(p=>p.name));
  const tableNames=await page.locator('table tbody .name-cell > span:not(.dotc):not(.chip)').evaluateAll(nodes=>nodes.map(n=>n.textContent));
  assert.ok(tableNames.length>0);assert.ok(tableNames.every(name=>enabledNames.has(name)),JSON.stringify(tableNames));
  assert.match(await page.locator('.quota-note').allTextContents().then(v=>v.join('\n')),new RegExp(microsoft.name));
  report.cases.push('通过翻译服务UI停用微软服务，真后台保存后状态表格移除，未启用服务仅在说明文字出现');

  const accurate=page.locator('h2').filter({hasText:'精确（精确 / 综合模式第二遍）'}).locator('xpath=following-sibling::div[1]').locator('table');
  await accurate.waitFor();
  const head=(await accurate.locator('thead th').allTextContents())[0];
  const ranks=await accurate.locator('tbody td.rank').allTextContents();
  assert.equal(head,'');assert.ok(ranks.length>0&&ranks.every(value=>value===''));
  report.accurate={header:head,cells:ranks,sourceFastRank:local.rank};
  const localRows=rows.filter({hasText:local.name});
  await localRows.first().getByRole('button',{name:'暂停',exact:true}).click();
  await localRows.first().getByRole('button',{name:'恢复',exact:true}).waitFor();
  assert.equal((await snapshot(page)).providers.find(p=>p.id==='llamacpp').enabled,true);
  assert.equal(await localRows.count(),2,'启用但暂停的服务应仍出现在两档以便恢复');
  await page.screenshot({path:path.join(output,'status-paused.png'),fullPage:true});
  await localRows.first().getByRole('button',{name:'恢复',exact:true}).click();
  await localRows.first().getByRole('button',{name:'暂停',exact:true}).waitFor();
  report.cases.push('真快照含快速排名，但精确表表头与排名单元格为空；启用但暂停的服务仍可见并可恢复');

  const article=await context.newPage();article.on('pageerror',e=>errors.push(e.message));await article.goto(address+'/layouts.html');
  await article.waitForSelector('tx-ui',{state:'attached'});
  await article.locator('tx-ui .ball').click();await article.mouse.move(5,5);
  await article.waitForFunction(()=>document.querySelectorAll('#tabs tx-t[data-tx-stage="final"]').length===3&&document.querySelectorAll('tx-t[data-tx-stage="final"]').length>=6,null,{timeout:20000});
  await article.waitForTimeout(600);
  report.tabs=await article.evaluate(()=>[...document.querySelectorAll('#tabs a')].map(a=>{
    const tx=a.querySelector('tx-t'), walker=document.createTreeWalker(a,NodeFilter.SHOW_TEXT);let original;const source=[];
    for(let n=walker.nextNode();n;n=walker.nextNode()){if(n.parentElement.closest('tx-t')||!n.nodeValue.trim())continue;source.push(n.nodeValue.trim());const range=document.createRange();range.selectNodeContents(n);original=range.getBoundingClientRect();}
    const translated=[...tx.getClientRects()].find(r=>r.height>0);
    return {source:source.join(' '),translation:tx.textContent.trim(),originalCenter:(original.top+original.bottom)/2,translatedCenter:(translated.top+translated.bottom)/2,delta:Math.abs((original.top+original.bottom-translated.top-translated.bottom)/2),stage:tx.dataset.txStage};
  }));
  assert.deepEqual(report.tabs.map(t=>t.translation),['指南','接口参考','发布说明']);
  assert.ok(report.tabs.every(t=>t.delta<=2),'标签栏原译文偏移：'+JSON.stringify(report.tabs));
  report.layout=await article.evaluate(()=>{
    const bad=[...document.querySelectorAll('tx-t')].map(t=>{const r=t.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(t);const c=range.getBoundingClientRect(),lh=parseFloat(getComputedStyle(t).lineHeight)||parseFloat(getComputedStyle(t).fontSize)*1.5;return{text:t.textContent.slice(0,20),h:r.height,c:c.height,w:r.width,lh};}).filter(x=>x.h>x.c+x.lh||x.w<20);
    const cloned=[...document.querySelectorAll('tx-t *')].filter(e=>/absolute|fixed/.test(getComputedStyle(e).position)).length;
    const lines=[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.height>200&&r.width>0&&r.width<6;}).length;
    return{bad,cloned,lines,inLabels:document.querySelectorAll('.tl tx-t').length,range:!!document.querySelector('#trange tx-t'),gridChildren:[...document.querySelector('#grid').children].filter(c=>c.tagName==='TX-T').length};
  });
  assert.deepEqual(report.layout,{bad:[],cloned:0,lines:0,inLabels:0,range:true,gridChildren:0});
  await article.screenshot({path:path.join(output,'layout-translated.png'),fullPage:true});
  assert.ok(requests.some(r=>r.source==='Guides'));assert.ok(requests.some(r=>r.source==='API Reference'));assert.ok(requests.some(r=>r.source==='Released Notes'));
  assert.ok(requests.every(r=>!r.cookie));assert.deepEqual(failures,[]);assert.deepEqual(errors,[]);
  report.cases.push('最新文档站夹具经真内容脚本→真后台→HTTP回放，三个顶部标签原译文中心差均≤2px，无撑高或贯穿竖线');
  report.requests=requests;report.healthChecks=healthChecks;report.passed=true;console.log(JSON.stringify(report));
} catch(error) {report.passed=false;report.failure=String(error.stack||error);report.requests=requests;report.fixtureFailures=failures;throw error;}
finally {
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  if(context)await context.close();const closing=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closing;
  if(path.dirname(path.resolve(profile))!==tempRoot||!path.basename(profile).startsWith('translate-handoff047-'))throw Error('拒绝清理未经验证的测试资料夹');
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:150});
}
