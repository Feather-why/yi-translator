import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { isolateAutomaticWelcome } from './browser-test-isolation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const extension = path.resolve(process.env.EXT_DIR || path.join(root, '.output/chrome-mv3'));
const output = path.resolve(process.env.REPORT_DIR || path.join(root, 'work/builtin-production-browser'));
await access(path.join(extension, 'manifest.json'));
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.version, version, '验收必须加载当前正式包');
await mkdir(output, { recursive: true });
const profileRoot = path.join(root, 'work/browser-profiles'); await mkdir(profileRoot, { recursive: true });
const profile = await mkdtemp(path.join(profileRoot, 'builtin-production-'));
const disabledFeatures = ['AvoidUnnecessaryBeforeUnloadCheckSync','DestroyProfileOnBrowserClose','DialMediaRouteProvider','GlobalMediaControls','HttpsUpgrades','LensOverlay','MediaRouter','PaintHolding','ThirdPartyStoragePartitioning','BlockOriginHeaderModificationOnRedirect','AvoidCorsURLLoaderRestartOnRedirect','Translate','AutoDeElevate','OptimizationHints','NetworkTimeServiceQuerying','AimEnabled','msForceBrowserSignIn','msEdgeUpdateLaunchServicesPreferredVersion'];
const report = { at: new Date().toISOString(), extension, manifestVersion: manifest.version, cases: [] };
const sourceFiles=['src/backend/core.ts','src/backend/index.ts','src/backend/builtin-setup.ts','src/backend/browser-translator-bridge.ts','src/backend/browser-translator-engine.ts','src/backend/providers/browser-translator.ts','src/entrypoints/offscreen/main.ts','src/entrypoints/offscreen/browser-translator.ts','src/entrypoints/offscreen/browser-translator-setup.ts'];
const packageFiles=['manifest.json','background.js','offscreen.html',...(await readdir(path.join(extension,'chunks'))).filter((name)=>/^(?:offscreen-|browser-translator-setup-).+\.js$/.test(name)).map((name)=>'chunks/'+name)];
const hashes=async(base,files)=>Object.fromEntries(await Promise.all(files.map(async(file)=>[file,createHash('sha256').update(await readFile(path.join(base,file))).digest('hex')])));
report.sourceHashes=await hashes(root,sourceFiles);report.packageHashes=await hashes(extension,packageFiles);
let context;

async function rpc(page, name, payload) {
  const reply = await page.evaluate(({name,payload}) => chrome.runtime.sendMessage({rpc:name,payload}), {name,payload});
  assert.equal(reply?.ok, true, JSON.stringify(reply)); return reply.data;
}
async function nativeStatus(page) {
  const reply = await page.evaluate(() => chrome.runtime.sendMessage({target:'tx-offscreen',task:'browser-translator:availability',payload:{sourceLang:'en',targetLang:'zh-CN'}}));
  assert.equal(reply?.ok,true,JSON.stringify(reply)); return reply.data;
}
async function translate(page, texts, providerHint) {
  const job = {jobId:crypto.randomUUID(),sourceLang:'auto',targetLang:'zh-CN',mode:'fast',priority:0,noCache:true,
    context:{url:'https://example.test/builtin-production-acceptance'},segments:texts.map((text,index)=>({id:`s${index}`,kind:'paragraph',text})),...(providerHint?{providerHint}:{})};
  const messages = await page.evaluate((job) => new Promise((resolve,reject) => {
    const port=chrome.runtime.connect({name:'tx:translate'}), messages=[];
    const timer=setTimeout(()=>{port.disconnect();reject(new Error('正式包真实翻译端口超时'));},60000);
    port.onMessage.addListener((message)=>{if(message.jobId!==job.jobId)return;messages.push(message);if(message.type==='job-done'&&message.stage==='final'){clearTimeout(timer);port.disconnect();resolve(messages);}});
    port.postMessage({type:'job',job});
  }),job);
  const results=messages.filter((message)=>message.type==='result').sort((a,b)=>a.segmentId.localeCompare(b.segmentId));
  const item={sourceLang:'auto',providerHint:providerHint??null,texts,messages,results}; report.cases.push(item);
  assert.equal(messages.filter((message)=>message.type==='job-done').length,1,JSON.stringify(item));
  assert.equal(results.length,texts.length,JSON.stringify(item));
  for(const result of results){assert.equal(result.provider,'browser-translator');assert.equal(result.stage,'final');assert.equal(result.cached,false);assert.match(result.text,/[\u4e00-\u9fff]/);}
  return results;
}
function structure(text) {
  const stack=[], records=[];
  for(const match of text.matchAll(/<(\/?)([gx])(\d+)(\/?)>/g)){
    const [,closing,kind,id,atom]=match, name=kind+id;
    if(kind==='x'){assert.equal(atom,'/');records.push(`x:${name}:${stack.join('/')}`);}
    else if(closing){assert.equal(stack.pop(),name,'g嵌套顺序必须保留');}
    else {assert.equal(atom,'');records.push(`g:${name}:${stack.join('/')}`);stack.push(name);}
  }
  assert.equal(stack.length,0);return records.sort();
}

try {
  context = await chromium.launchPersistentContext(profile,{headless:process.env.HEADED!=='1',viewport:{width:1250,height:900},
    executablePath:process.env.BROWSER_EXECUTABLE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ignoreDefaultArgs:['--disable-extensions','--disable-component-update','--disable-background-networking','--disable-features='+disabledFeatures.join(',')],
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--disable-features='+disabledFeatures.filter((feature)=>feature!=='Translate').join(',')]});
  report.browserVersion=context.browser()?.version();report.headless=process.env.HEADED!=='1';
  let [worker]=context.serviceWorkers();worker ||= await context.waitForEvent('serviceworker',{timeout:15000});
  const id=new URL(worker.url()).host;report.extensionId=id;
  await isolateAutomaticWelcome(context,id);
  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get('settings.ui');
    await chrome.storage.local.set({ 'settings.ui': { ...stored['settings.ui'], targetLang: 'zh-CN', uiLang: 'zh-CN' } });
  });
  const settings=await context.newPage();await settings.goto(`chrome-extension://${id}/options.html#providers`);
  report.ping=await rpc(settings,'ping');
  assert.equal(report.ping.backend,`${version}-release`);
  const providers=await rpc(settings,'providers:list');
  assert.ok(providers.some((provider)=>provider.id==='browser-translator'));
  assert.equal(providers.some((provider)=>provider.id==='pseudo'),false,'必须加载正式包');
  for(const provider of providers)await rpc(settings,'providers:save',{id:provider.id,enabled:provider.id==='browser-translator',config:provider.config});
  report.providersBefore=await rpc(settings,'providers:list');
  assert.deepEqual(report.providersBefore.filter((provider)=>provider.enabled).map((provider)=>provider.id),['browser-translator']);
  report.firstTest=await rpc(settings,'providers:test',{id:'browser-translator'});
  // 由真正的 service worker bridge 创建 offscreen，避免测试替生产完成初始化。
  report.before=await nativeStatus(settings);
  if(report.before.status!=='available'){
    assert.equal(report.firstTest.ok,false);assert.ok(['downloadable','downloading'].includes(report.before.status),JSON.stringify(report.before));
    let setup;
    for(let attempt=0;attempt<50&&!setup;attempt++){
      setup=context.pages().find((page)=>page.url()===`chrome-extension://${id}/options.html#providers/browser-translator`);
      if(!setup)await new Promise((resolve)=>setTimeout(resolve,100));
    }
    assert.ok(setup,'显式providers:test必须打开设置页语言包卡片');report.setupUrl=setup.url();
    await setup.getByRole('button',{name:'下载语言包',exact:true}).click();
    await setup.waitForFunction(()=>document.querySelector('.bp .ok')?.textContent?.includes('语言包已下载'),null,{timeout:Number(process.env.BUILTIN_PREPARE_TIMEOUT_MS||90000)});
    report.preparationStatus=await setup.locator('.bp').innerText();
    await setup.screenshot({path:path.join(output,'preparation.png')});
  }
  report.after=await nativeStatus(settings);assert.equal(report.after.status,'available');
  report.secondTest=await rpc(settings,'providers:test',{id:'browser-translator'});assert.equal(report.secondTest.ok,true,JSON.stringify(report.secondTest));
  const natural=await translate(settings,[
    'The browser translates complete sentences locally after the required language package has been downloaded. This paragraph checks that the translation service is connected to the official extension backend.',
    'Children are reading a book beside the window while a small dog sleeps quietly. Tomorrow we will visit the museum together and learn about science and history.'
  ]);
  assert.match(natural[0].text,/浏览器/);assert.match(natural[0].text,/本地|本机|此计算机/);
  assert.match(natural[1].text,/狗|犬/);assert.match(natural[1].text,/博物馆/);
  const linked='<g0>The browser can translate complete English sentences on this computer after its language package has been downloaded.</g0> Keep the code <x0/> unchanged and visit <g1><g2>the official website</g2></g1> for more information about the software.';
  const [tagged]=await translate(settings,[linked],'browser-translator');
  assert.deepEqual(structure(tagged.text),structure(linked));
  assert.match(tagged.text.match(/<g2>([\s\S]*?)<\/g2>/)?.[1]||'',/官方|网站/,'网站链接必须仍包围实际网站译词');
  report.providersAfter=await rpc(settings,'providers:list');
  await settings.reload();await settings.screenshot({path:path.join(output,'providers.png')});
  report.passed=true;console.log(JSON.stringify(report));
} catch(error){report.passed=false;report.failure=String(error?.stack||error);throw error;}
finally {
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  if(context)await context.close();
  if(path.dirname(path.resolve(profile))!==path.resolve(profileRoot)||!path.basename(profile).startsWith('builtin-production-'))throw Error('拒绝清理未经验证的测试资料夹');
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:150});
}
