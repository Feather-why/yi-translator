import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { build } from 'vite';
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = path.join(root, 'work/builtin-browser-fixture'); const extension = path.join(fixture, 'dist');
if (path.dirname(fixture) !== path.join(root, 'work')) throw Error('拒绝使用未经验证的fixture目录');
await mkdir(fixture, { recursive: true });
await writeFile(path.join(fixture, 'offscreen.html'), '<html><body><script type="module" src="../../src/entrypoints/offscreen/main.ts"></script></body></html>');
await writeFile(path.join(fixture, 'harness.html'), '<html><body><h1>Browser Translator integration</h1></body></html>');
await writeFile(path.join(fixture, 'background.ts'), `import {createBrowserTranslatorBridge} from '../../src/backend/browser-translator-bridge';
const bridge=createBrowserTranslatorBridge();
chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
  if(message?.target!=='tx-builtin-fixture')return false;
  const signal=new AbortController().signal;
  const result=message.kind==='availability'?bridge.availability(message.input.sourceLang,message.input.targetLang,signal):bridge.translate(message.input,signal);
  result.then((data)=>reply({ok:true,data}),(error)=>reply({ok:false,error:error.info||{message:String(error)}}));return true;
});`);
await build({ configFile: false, root: fixture, base: './', publicDir: false, logLevel: 'warn', build: { outDir: extension, emptyOutDir: true,
  rolldownOptions: { input: { offscreen: path.join(fixture, 'offscreen.html'), harness: path.join(fixture, 'harness.html'), background:path.join(fixture,'background.ts') },output:{entryFileNames:'[name].js'} } } });
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Native browser translation test fixture', version: '1.0.0', permissions: ['offscreen'],
  background: { service_worker: 'background.js',type:'module' }, content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'" } }));
const disabledFeatures = ['AvoidUnnecessaryBeforeUnloadCheckSync','DestroyProfileOnBrowserClose','DialMediaRouteProvider','GlobalMediaControls','HttpsUpgrades','LensOverlay','MediaRouter','PaintHolding','ThirdPartyStoragePartitioning','BlockOriginHeaderModificationOnRedirect','AvoidCorsURLLoaderRestartOnRedirect','Translate','AutoDeElevate','OptimizationHints','NetworkTimeServiceQuerying','AimEnabled','msForceBrowserSignIn','msEdgeUpdateLaunchServicesPreferredVersion'];
const profileRoot = path.join(root, 'work/browser-profiles'); await mkdir(profileRoot, { recursive: true });
const profile = await mkdtemp(path.join(profileRoot, 'builtin-native-')); let context;
try {
  context = await chromium.launchPersistentContext(profile, { headless: process.env.HEADED !== '1',
    executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    // 只撤回测试框架主动关闭的翻译与组件下载，不强开实验特性或修改用户浏览器。
    ignoreDefaultArgs: ['--disable-extensions','--disable-component-update','--disable-background-networking','--disable-features='+disabledFeatures.join(',')],
    args: [`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--disable-features='+disabledFeatures.filter((feature)=>feature!=='Translate').join(',')] });
  let [worker] = context.serviceWorkers(); worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage(); await page.goto(`chrome-extension://${id}/harness.html`);
  await worker.evaluate(() => chrome.offscreen.createDocument({ url:'offscreen.html',reasons:['WORKERS'],justification:'验证内置Translator在真实offscreen窗口中运行' }));
  const task = async (name,payload) => {
    const reply = await page.evaluate(({name,payload})=>chrome.runtime.sendMessage({target:'tx-offscreen',task:name,payload}),{name,payload});
    assert.equal(reply?.ok,true,JSON.stringify(reply)); return reply.data;
  };
  const before = await task('browser-translator:availability',{sourceLang:'en',targetLang:'zh-CN'});
  assert.ok(['available','downloadable','downloading','unavailable'].includes(before.status));
  console.log(JSON.stringify({stage:'availability-before',...before}));
  const setup = await context.newPage(); await setup.goto(`chrome-extension://${id}/offscreen.html?translatorSetup=1&sourceLang=en&targetLang=zh`);
  await setup.getByRole('button',{name:'下载并启用翻译语言包',exact:true}).waitFor();
  await setup.getByRole('button',{name:'下载并启用翻译语言包',exact:true}).click();
  let preparationTimedOut = false;
  try { await setup.waitForFunction(()=>document.querySelector('#translation-status')?.textContent && !document.querySelector('#translation-status').textContent.includes('正在准备'),null,{timeout:Number(process.env.BUILTIN_PREPARE_TIMEOUT_MS||90000)}); }
  catch { preparationTimedOut = true; await setup.getByRole('button',{name:'停止等待',exact:true}).click(); }
  const translationSetupStatus = await setup.locator('#translation-status').innerText();
  console.log(JSON.stringify({stage:'translation-setup',preparationTimedOut,status:translationSetupStatus}));
  await setup.getByRole('button',{name:'准备自动识别语言',exact:true}).click();
  let detectionTimedOut = false;
  try { await setup.waitForFunction(()=>document.querySelector('#detector-status')?.textContent && !document.querySelector('#detector-status').textContent.includes('正在准备'),null,{timeout:15000}); }
  catch { detectionTimedOut = true; await setup.getByRole('button',{name:'停止等待',exact:true}).click(); }
  const detectorSetupStatus = await setup.locator('#detector-status').innerText();
  await setup.screenshot({path:path.join(root,'work/builtin-setup-browser.png')});
  const after = await task('browser-translator:availability',{sourceLang:'en',targetLang:'zh-CN'});
  const automaticNative = await task('browser-translator:availability',{sourceLang:'auto',targetLang:'zh-CN'});
  const automatic = await page.evaluate(()=>chrome.runtime.sendMessage({target:'tx-builtin-fixture',kind:'availability',input:{sourceLang:'auto',targetLang:'zh-CN'}}));
  const detectionText='The browser translates this sentence locally. The built-in translator runs on this computer after downloading a language pack. This paragraph is written in English to verify reliable language detection.';
  const cldDetection = await worker.evaluate((text)=>chrome.i18n.detectLanguage(text),detectionText);
  const automaticTranslation = await page.evaluate((text)=>chrome.runtime.sendMessage({target:'tx-builtin-fixture',kind:'translate',input:{texts:[text],sourceLang:'auto',targetLang:'zh-CN'}}),detectionText);
  if(after.status==='available'&&cldDetection.isReliable&&cldDetection.languages[0]?.percentage>=90){assert.equal(automaticTranslation.ok,true,JSON.stringify(automaticTranslation));assert.match(automaticTranslation.data[0],/[\u4e00-\u9fff]/);}
  let translation;
  if (after.status === 'available') {
    translation = await task('browser-translator:translate',{id:crypto.randomUUID(),texts:['The browser translates this sentence locally.'],sourceLang:'en',targetLang:'zh-CN'});
    assert.equal(translation.ok,true,JSON.stringify(translation)); assert.match(translation.texts[0],/[\u4e00-\u9fff]/); console.log(JSON.stringify({stage:'real-native-translation',translation}));
  } else {
    translation = await task('browser-translator:translate',{id:crypto.randomUUID(),texts:['The browser translates this sentence locally.'],sourceLang:'en',targetLang:'zh-CN'});
    assert.equal(translation.ok,false); assert.equal(translation.error.code,'no_provider');
  }
  const report = {at:new Date().toISOString(),browserVersion:context.browser()?.version(),headless:process.env.HEADED!=='1',before,after,automaticNative,automatic,cldDetection,automaticTranslation,translationSetupStatus,detectorSetupStatus,preparationTimedOut,detectionTimedOut,translation,realTranslationVerified:translation.ok===true,realAutoTranslationVerified:automaticTranslation.ok===true};
  await writeFile(path.join(root,'work/builtin-browser-result.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
} finally {
  if(context)await context.close();
  if(path.dirname(path.resolve(profile))!==path.resolve(profileRoot)||!path.basename(profile).startsWith('builtin-native-'))throw Error('拒绝清理未经验证的测试资料夹');
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:150});
}
