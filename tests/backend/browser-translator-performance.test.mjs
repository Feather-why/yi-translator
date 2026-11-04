import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const { BrowserTranslatorEngine } = require(path.join(build, 'backend/browser-translator-engine.js'));
const input = (sourceLang = 'en') => ({ texts: ['A complete source sentence.'], sourceLang, targetLang: 'zh-CN' });
function fixture() {
  const calls = { translatorAvailability: [], translatorCreate: 0, detectorAvailability: 0, detectorCreate: 0, detect: 0, translated: 0, destroyed: 0 };
  const environment = { secure: true, translator: {
    async availability(pair) { calls.translatorAvailability.push(pair); return 'available'; },
    async create() { calls.translatorCreate++; return { async translate() { calls.translated++; return '完整译文。'; }, destroy() { calls.destroyed++; } }; },
  }, detector: {
    async availability() { calls.detectorAvailability++; return 'available'; },
    async create() { calls.detectorCreate++; return { async detect() { calls.detect++; return [{ detectedLanguage: 'fr', confidence: 0.99 }]; }, destroy() {} }; },
  } };
  return { calls, environment, engine: new BrowserTranslatorEngine(() => environment) };
}
async function withoutDetectorDelay(work) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Unneeded detector blocked an explicit language pair')), 200); })]);
  } finally { clearTimeout(timer); }
}

test('明确语言的首次及缓存会话翻译不调用未响应的检测器', async (t) => {
  const { engine, environment, calls } = fixture(); t.after(() => engine.dispose());
  environment.detector.availability = () => { calls.detectorAvailability++; return new Promise(() => {}); };
  assert.deepEqual(await withoutDetectorDelay(engine.translate(input())), ['完整译文。']);
  assert.deepEqual(await withoutDetectorDelay(engine.translate(input())), ['完整译文。']);
  assert.equal(calls.detectorAvailability, 0); assert.equal(calls.detectorCreate, 0);
  assert.equal(calls.translatorCreate, 1); assert.equal(calls.translated, 2);
});

test('明确语言可用性查询仅检查实际翻译语言对', async (t) => {
  const { engine, environment, calls } = fixture(); t.after(() => engine.dispose());
  environment.detector.availability = () => { throw Error('Explicit pair must not inspect the detector'); };
  const status = await engine.availability('de', 'zh-CN');
  assert.equal(status.status, 'available'); assert.equal(status.sourceLanguage, 'de');
  assert.deepEqual(calls.translatorAvailability, [{ sourceLanguage: 'de', targetLanguage: 'zh' }]);
});

test('真正auto仍检查真实检测器，检测后的明确语言不重复探测', async (t) => {
  const { engine, calls } = fixture(); t.after(() => engine.dispose());
  assert.deepEqual(await engine.translate(input('auto')), ['完整译文。']);
  assert.equal(calls.detectorAvailability, 1); assert.equal(calls.detectorCreate, 1); assert.equal(calls.detect, 1);
  assert.deepEqual(calls.translatorAvailability, [{ sourceLanguage: 'fr', targetLanguage: 'zh' }]);
  const status = await engine.availability('auto', 'zh');
  assert.equal(status.supportsAuto, true); assert.equal(status.detectorStatus, 'available');
  assert.equal(calls.detectorAvailability, 2);
});

test('不引入TTL：下载完成立即可用，已缓存会话也不能掩盖语言对失效', async (t) => {
  const { engine, environment, calls } = fixture(); t.after(() => engine.dispose());
  let state = 'downloadable';
  environment.translator.availability = async (pair) => { calls.translatorAvailability.push(pair); return state; };
  await assert.rejects(engine.translate(input()), (error) => error.info?.code === 'no_provider');
  assert.equal(calls.translatorCreate, 0);
  state = 'available'; assert.deepEqual(await engine.translate(input()), ['完整译文。']);
  assert.equal(calls.translatorCreate, 1);
  state = 'unavailable'; await assert.rejects(engine.translate(input()), (error) => error.info?.code === 'no_provider');
  assert.equal(calls.translated, 1); assert.equal(calls.translatorAvailability.length, 3);
});

test('auto检测未准备或不可靠仍降级，不猜语言也不后台下载', async () => {
  for (const state of ['unavailable', 'downloadable', 'downloading']) {
    const { engine, environment, calls } = fixture();
    try {
      environment.detector.availability = async () => state;
      await assert.rejects(engine.translate(input('auto')), (error) => error.info?.code === 'no_provider');
      assert.equal(calls.detectorCreate, 0); assert.equal(calls.translatorCreate, 0);
    } finally { engine.dispose(); }
  }
  const { engine, environment, calls } = fixture();
  try {
    environment.detector.create = async () => ({ detect: async () => [{ detectedLanguage: 'en', confidence: 0.6 }], destroy() {} });
    await assert.rejects(engine.translate(input('auto')), (error) => error.info?.code === 'no_provider');
    assert.equal(calls.translatorCreate, 0);
  } finally { engine.dispose(); }
});

test('明确语言检查等待期间取消仍立即拒绝，不创建会话', async (t) => {
  const { engine, environment, calls } = fixture(); t.after(() => engine.dispose());
  let entered; const begun = new Promise((resolve) => { entered = resolve; });
  environment.translator.availability = async () => { entered(); return new Promise(() => {}); };
  const controller = new AbortController(), pending = engine.translate(input(), controller.signal);
  await begun; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls.translatorCreate, 0); assert.equal(calls.detectorAvailability, 0);
});

test('真正auto在检测器检查期间取消仍拒绝，不进入翻译', async (t) => {
  const { engine, environment, calls } = fixture(); t.after(() => engine.dispose());
  let entered; const begun = new Promise((resolve) => { entered = resolve; });
  environment.detector.availability = async () => { entered(); return new Promise(() => {}); };
  const controller = new AbortController(), pending = engine.translate(input('auto'), controller.signal);
  await begun; controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls.translatorCreate, 0); assert.equal(calls.translated, 0);
});
