import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), build = path.resolve(process.env.BACKEND_BUILD_DIR || 'tests/.compiled');
const libreModule = require(path.join(build, 'backend/providers/libretranslate.js')), customModule = require(path.join(build, 'backend/providers/custom-http.js'));
const libre = libreModule.default, custom = customModule.default;
const options = require(path.join(build, 'backend/provider-options.js'));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const request = (texts = ['Hello'], sourceLang = 'auto', targetLang = 'zh-CN') => ({ texts, sourceLang, targetLang });
function context(config, handler) {
  const calls = [], logs = [];
  return { config, calls, logs, signal: new AbortController().signal, log(value) { logs.push(value); }, fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init); } };
}
const rejected = (code) => (error) => error.info?.code === code;

test('LibreTranslate默认本机、可选密钥、一次数组请求及新增语言映射', async () => {
  const cases = [['zh-CN', 'zh'], ['zh-Hans', 'zh'], ['zh-TW', 'zt'], ['zh-Hant', 'zt'], ['zh-HK', 'zt'], ...'sv nl pl tr uk vi th id ar pt it'.split(' ').map(code => [code, code])];
  for (const [from, mapped] of cases) {
    const ctx = context({}, (url, init) => { assert.equal(url, 'http://127.0.0.1:5000/translate'); assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
      const body = JSON.parse(init.body); assert.equal(body.source, mapped); assert.equal(body.target, 'en'); assert.equal(body.format, 'text'); assert.deepEqual(body.q, ['Hello', 'World']); assert.equal(Object.hasOwn(body, 'api_key'), false); return json({ translatedText: ['你好', '世界'] }); });
    assert.deepEqual(await libre.translate(request(['Hello', 'World'], from, 'en'), ctx), ['你好', '世界']); assert.equal(ctx.calls.length, 1);
  }
  const ctx = context({ url: 'https://translate.example/api/', key: 'fixture-secret' }, (url, init) => { assert.equal(url, 'https://translate.example/api/translate'); assert.equal(JSON.parse(init.body).api_key, 'fixture-secret'); return json({ translatedText: ['译文'] }); });
  await libre.translate(request(), ctx); assert.deepEqual(ctx.logs, []); assert.equal(libre.freeQuota, undefined);
});

test('LibreTranslate保留完整句子、严格检查标签数量和父子关系', async () => {
  const source = 'Read <g0>the <g1>new guide</g1></g0> <x0/> now.';
  const ctx = context({}, (_url, init) => { assert.deepEqual(JSON.parse(init.body).q, [source]); return json({ translatedText: ['现在阅读<g0>这份<g1>新指南</g1></g0> <x0/>。'] }); });
  assert.match((await libre.translate(request([source]), ctx))[0], /新指南/);
  for (const target of ['阅读新指南', '<g0>阅读</g0><g1>新指南</g1><x0/>', '<g0><g1>指南</g1></g0><x1/>']) await assert.rejects(libre.translate(request([source]), context({}, () => json({ translatedText: [target] }))), rejected('placeholder'));
  assert.equal(libre.cost(request(['A😀<g0>B</g0><x0/>'])), 3);
});

test('LibreTranslate拒绝异常数量、空译文和标量响应，未发送空批次', async () => {
  for (const response of [{ translatedText: [] }, { translatedText: ['一', '二'] }, { translatedText: [''] }, { translatedText: '译文' }, { translatedText: [42] }]) await assert.rejects(libre.translate(request(), context({}, () => json(response))), rejected('server'));
  const ctx = context({}, () => { throw Error('不能发送'); }); assert.deepEqual(await libre.translate(request([]), ctx), []);
});

test('LibreTranslate语言错误与其他HTTP错误分类明确，错误不回显服务内容', async () => {
  for (const [status, code] of [[400, 'bad_input'], [401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [500, 'server']]) await assert.rejects(libre.translate(request(), context({}, () => json({ error: 'fixture-secret' }, status))), error => error.info.code === code && !JSON.stringify(error.info).includes('fixture-secret'));
  await assert.rejects(libre.translate(request(), context({}, () => json({ error: 'fixture-secret' }))), rejected('server'));
  await assert.rejects(libre.translate(request(['x'], 'sv', 'auto'), context({}, () => { throw Error('不能发送'); })), rejected('bad_input'));
});

test('LibreTranslate健康检查只取语言列表，地址不允许凭据/查询/片段', async () => {
  const ctx = context({}, (url, init) => { assert.equal(url, 'http://127.0.0.1:5000/languages'); assert.equal(init.body, undefined); return json([{ code: 'en', targets: ['zh'] }]); });
  assert.equal((await libre.health(ctx)).ok, true); assert.equal(ctx.calls.length, 1);
  for (const url of ['file:///C:/file', 'https://u:p@translate.example', 'https://translate.example/?key=secret', 'https://translate.example/#secret']) assert.throws(() => libreModule.validateLibreTranslateConfig({ url }), rejected('bad_input'));
  await assert.rejects(libre.health(context({}, () => json([]))), rejected('server'));
});

test('custom-http按JSON值单次替换，原文中的引号/换行/变量不是第二层模板', async () => {
  const source = 'Hello "{{to}}"\n<g0>guide</g0> <x0/> \\';
  const ctx = context({ url: 'https://custom.example/translate', headers: '{"Authorization":"Bearer fixture-secret"}', body: '{"request":{"text":"Prefix {{text}}","from":"{{from}}","to":"{{to}}"},"count":1,"safe":true}', resultPath: 'data.translated' }, (_url, init) => {
    const body = JSON.parse(init.body); assert.deepEqual(body, { request: { text: 'Prefix ' + source, from: 'sv', to: 'en' }, count: 1, safe: true });
    assert.equal(init.headers.Authorization, 'Bearer fixture-secret'); assert.equal(init.headers['Content-Type'], 'application/json'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    return json({ data: { translated: source.replace('Hello', '你好') } });
  });
  const out = await custom.translate(request([source], 'sv', 'en'), ctx); assert.ok(out[0].includes('{{to}}')); assert.equal(ctx.calls.length, 1); assert.deepEqual(ctx.logs, []);
});

test('custom-http数组模式一次HTTP，texts成为数组，路径通配返回顺序保持', async () => {
  const texts = ['A <g0>one</g0>', 'B <x1/>'];
  const ctx = context({ url: 'http://127.0.0.1:5000/translate', batch: 'array', body: '{"inputs":"{{texts}}","from":"{{from}}","to":"{{to}}"}', resultPath: '$.data.translations[*].text' }, (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { inputs: texts, from: 'zh-CN', to: 'en' }); return json({ data: { translations: [{ text: '甲 <g0>一</g0>' }, { text: '乙 <x1/>' }] } });
  });
  assert.deepEqual(await custom.translate(request(texts, 'zh-CN', 'en'), ctx), ['甲 <g0>一</g0>', '乙 <x1/>']); assert.equal(ctx.calls.length, 1);
});

test('custom-http默认模板、完整变量值和直接根结果均可使用', async () => {
  const single = context({ url: 'https://custom.example' }, (_url, init) => { assert.deepEqual(JSON.parse(init.body), { q: 'Hello', source: 'auto', target: 'zh-CN' }); return json({ translatedText: '译文' }); });
  assert.deepEqual(await custom.translate(request(), single), ['译文']);
  const array = context({ url: 'https://custom.example', batch: 'array', body: '"{{texts}}"', resultPath: '$' }, (_url, init) => { assert.deepEqual(JSON.parse(init.body), ['A', 'B']); return json(['甲', '乙']); });
  assert.deepEqual(await custom.translate(request(['A', 'B']), array), ['甲', '乙']);
  const index = context({ url: 'https://custom.example', resultPath: '$[0]["translation-text"]' }, () => json([{ 'translation-text': '译文' }])); assert.deepEqual(await custom.translate(request(), index), ['译文']);
});

test('custom-http单段模式不在adapter内偷偷循环HTTP，数组批量上限明确', async () => {
  const ctx = context({ url: 'https://custom.example' }, () => { throw Error('不能发送'); });
  await assert.rejects(custom.translate(request(['one', 'two']), ctx), rejected('bad_input'));
  assert.deepEqual(await custom.translate(request([]), ctx), []); assert.equal(ctx.calls.length, 0);
  await assert.rejects(custom.translate(request(Array(17).fill('x')), context({ ...ctx.config, batch: 'array' }, () => json({}))), rejected('bad_input'));
});

test('custom-http缺失、多余、错误类型、空响应都拒绝，标签必须一致', async () => {
  const config = { url: 'https://custom.example', batch: 'array', resultPath: 'data[*].text' };
  for (const value of [{}, { data: [] }, { data: [{ text: '一' }, { text: '二' }] }, { data: [{ text: null }] }, { data: [{ text: '' }] }]) await assert.rejects(custom.translate(request(), context(config, () => json(value))), rejected('server'));
  const source = '<g0>A<g1>B</g1></g0><x0/>';
  for (const target of ['译文', '<g0>A</g0><g1>B</g1><x0/>']) await assert.rejects(custom.translate(request([source]), context({ url: config.url }, () => json({ translatedText: target }))), rejected('placeholder'));
  assert.equal(custom.cost(request(['😀<g0>A</g0><x0/>'])), 2);
});

test('custom-http返回路径只读自有JSON字段，不允许原型、表达式、递归或过滤器', () => {
  for (const resultPath of ['__proto__.x', 'data.constructor.x', 'data["prototype"]', '$..text', 'data[?(@.text)]', 'data[0].text()', 'data[*] || globalThis.run()', 'data[9007199254740992]', 'data["*"]']) assert.throws(() => customModule.validateCustomHttpConfig({ resultPath }), rejected('bad_input'), resultPath);
});

test('custom-http模板禁止原型字段、未知变量、文本数组拼进字符串及无原文变量', () => {
  for (const body of ['{', '{"q":"{{unknown}}"}', '{"q":"prefix {{texts}}"}', '{"q":1}', '{"__proto__":{"q":"{{text}}"}}', '{"q":{"constructor":"{{text}}"}}', '{"{{text}}":"{{text}}"}']) assert.throws(() => customModule.validateCustomHttpConfig({ body }), rejected('bad_input'));
  assert.throws(() => customModule.validateCustomHttpConfig({ batch: 'array', body: '{"q":"{{text}}"}' }), rejected('bad_input'));
  assert.throws(() => customModule.validateCustomHttpConfig({ body: '['.repeat(25) + '"{{text}}"' + ']'.repeat(25) }), rejected('bad_input'));
  assert.throws(() => customModule.validateCustomHttpConfig({ body: JSON.stringify({ q: '{{text}}', pad: 'x'.repeat(64000) }) }), rejected('bad_input'));
});

test('custom-http请求头必须是安全JSON对象，禁止cookie/伪造origin/换行/大小写重名', () => {
  for (const headers of ['{', '[]', '{"X":1}', '{"Cookie":"session=fixture-secret"}', '{"Origin":"https://example.com"}', '{"Host":"example.com"}', '{"Sec-Fetch-Site":"same-origin"}', '{"X":"one\\r\\nTwo: value"}', '{"Authorization":"a","authorization":"b"}', '{"__proto__":"x"}', '{"Content-Type":"text/plain"}']) assert.throws(() => customModule.validateCustomHttpConfig({ headers }), rejected('bad_input'));
  customModule.validateCustomHttpConfig({ headers: '{"Content-Type":"application/problem+json; charset=utf-8","X-Key":"fixture-secret"}' });
  for (const field of ['headers', 'body']) assert.equal(custom.auth.find(value => value.key === field).secret, true);
});

test('custom-http空地址可存草稿但不能发送，非法地址/批量字段及时拒绝', async () => {
  customModule.validateCustomHttpConfig({});
  for (const url of ['file:///C:/secret', 'https://u:p@custom.example', 'https://custom.example/?key=secret', 'https://custom.example/#secret']) assert.throws(() => customModule.validateCustomHttpConfig({ url }), rejected('bad_input'));
  for (const batch of ['parallel', 'true']) assert.throws(() => customModule.validateCustomHttpConfig({ batch }), rejected('bad_input'));
  await assert.rejects(custom.translate(request(), context({}, () => { throw Error('不能发送'); })), rejected('bad_input'));
});

test('custom-http不回显上游带密钥的错误，429/鉴权等仍正确分类', async () => {
  for (const [status, code] of [[400, 'bad_input'], [401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [500, 'server']]) await assert.rejects(custom.translate(request(), context({ url: 'https://custom.example' }, () => json({ error: 'fixture-secret' }, status))), error => error.info.code === code && !JSON.stringify(error.info).includes('fixture-secret'));
  await assert.rejects(custom.translate(request(), context({ url: 'https://custom.example' }, () => json({ error: 'fixture-secret' }))), error => error.info.code === 'server' && !error.message.includes('fixture-secret'));
});

test('新模板元数据不暴露无效model选项，Libre保留约定默认本机地址', () => {
  assert.deepEqual(options.providerTemplates(), ['openai-compatible', 'llamacpp', 'remote-node', 'libretranslate', 'custom-http']);
  const lt = options.cloneProvider('libretranslate', 'custom-libre-032', '实例');
  const ht = options.cloneProvider('custom-http', 'custom-http-032', '实例');
  assert.equal(lt.defaults.url, 'http://127.0.0.1:5000'); assert.equal(ht.defaults.url, undefined);
  for (const p of [lt, ht]) { const metadata = options.providerMetadata(p); assert.ok(metadata.editable.includes('endpoint')); assert.equal(metadata.editable.includes('model'), false); assert.equal(metadata.defaults.model, undefined); }
  assert.equal(options.effectiveProvider(ht, {}, { batch: 'single' }).limits.maxSegments, 1);
  assert.equal(options.effectiveProvider(ht, {}, { batch: 'array' }).limits.maxSegments, 16);
  options.validateProviderConfig(ht, {}); assert.throws(() => options.validateProviderConfig(ht, { headers: 'bad json' }), rejected('bad_input'));
  assert.equal(lt.official, true); assert.equal(ht.official, true); assert.equal(lt.freeQuota, undefined); assert.equal(ht.freeQuota, undefined);
});
