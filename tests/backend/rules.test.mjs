import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { RuleService, validateRule } = require('../.compiled/backend/rules/index.js');
const area = (initial = {}) => { const data = structuredClone(initial); return { data, get: async (key) => ({ [key]: structuredClone(data[key]) }), set: async (items) => { Object.assign(data, structuredClone(items)); } }; };
const rule = (id, match, extra = {}) => ({ id, match: [match], source: 'local', ...extra });

test('规则按本地>订阅>内置优先，再选择最具体匹配，查询仅在本地完成', async () => {
  let calls = 0;
  const service = new RuleService({ storage: area(), fetch: async () => { calls++; return new Response(JSON.stringify([rule('sub', 'https://example.test/articles/*')])); }, builtin: [rule('builtin', 'https://example.test/articles/special/*', { source: 'builtin' })] });
  await service.ready(); await service.subscribe('https://rules.example/sub.json');
  assert.equal(service.forUrl('https://example.test/articles/special/a').id, 'sub');
  await service.save(rule('local-general', 'https://example.test/*'));
  await service.save(rule('local-specific', 'https://example.test/articles/*'));
  assert.equal(service.forUrl('https://example.test/articles/special/a').id, 'local-specific');
  assert.equal(service.forUrl('https://other.example/a'), null);
  assert.equal(service.forUrl('javascript:alert(1)'), null);
  for (let n = 0; n < 100; n++) assert.equal(service.forUrl('https://example.test/articles/x').id, 'local-specific');
  assert.equal(calls, 1);
});

test('规则拒绝脚本字段、危险样式和错误结构；外部 source 不能伪装本地优先级', async () => {
  for (const value of [rule('x', 'javascript://*'), rule('x', 'https://*', { script: 'alert(1)' }), rule('x', 'https://*', { style: { background: 'red' } }),
    rule('x', 'https://*', { style: { 'font-family': 'url(https://evil.example)' } }), rule('x', 'https://*', { style: { 'font-size': '12px; color:red' } }),
    rule('x', 'https://*', { style: { 'line-height': 'expression(alert(1))' } }), rule('x', 'https://*', { autoTranslate: 'yes' })]) assert.throws(() => validateRule(value));
  assert.equal(validateRule(rule('x', 'https://*', { source: 'local' }), 'subscription').source, 'subscription');
  assert.deepEqual(validateRule(rule('x', 'https://*', { style: { 'font-size': '95%', 'line-height': '1.6' } })).style, { 'font-size': '95%', 'line-height': '1.6' });
});

test('真实HTTP订阅使用ETag，坏更新保留last-good，可回退上一个有效版本，不带Cookie', async (t) => {
  let payload = [rule('version-one', 'https://site.test/*')], etag = '"one"';
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return; }
    res.writeHead(200, { etag, 'content-type': 'application/json' }).end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/rules.json`;
  const storage = area(); const service = new RuleService({ storage, now: () => 1000 }); await service.ready();
  await service.subscribe(url); assert.equal(service.forUrl('https://site.test/a').id, 'version-one');
  await service.refresh(); assert.equal(seen[1]['if-none-match'], '"one"');
  payload = '<script>bad()</script>'; etag = '"bad"'; await service.refresh();
  assert.equal(service.forUrl('https://site.test/a').id, 'version-one'); assert.match(service.list().subscriptions[0].lastError, /上次有效/);
  payload = [rule('version-two', 'https://site.test/*')]; etag = '"two"'; await service.refresh();
  assert.equal(service.forUrl('https://site.test/a').id, 'version-two'); await service.rollback(url);
  assert.equal(service.forUrl('https://site.test/a').id, 'version-one'); assert.ok(seen.every((entry) => entry.cookie === undefined));
  const restored = new RuleService({ storage }); await restored.ready(); assert.equal(restored.forUrl('https://site.test/a').id, 'version-one');
});

test('订阅结构/大小异常不执行远程内容，移除本地规则及订阅会立即影响查询', async () => {
  const service = new RuleService({ storage: area(), fetch: async () => new Response('[]', { headers: { 'content-length': '3000000' } }) });
  await service.ready(); await service.subscribe('https://rules.example/large.json'); assert.match(service.list().subscriptions[0].lastError, /更新失败/);
  await service.save(rule('test', 'https://example.test/*')); await service.remove('test'); assert.equal(service.forUrl('https://example.test/a'), null);
  await service.unsubscribe('https://rules.example/large.json'); assert.equal(service.list().subscriptions.length, 0);
  await assert.rejects(service.subscribe('https://user:password@rules.example/rules.json'));
});

test('内置MDN/Wikipedia正文规则实际存在，热查询低于30ms且不会返回可修改内部引用', async () => {
  const service = new RuleService({ storage: area() }); await service.ready();
  const started = performance.now(); const found = service.forUrl('https://en.wikipedia.org/wiki/Machine_translation');
  assert.ok(performance.now() - started < 30); assert.deepEqual(found.include, ['#mw-content-text']); found.include[0] = 'bad';
  assert.deepEqual(service.forUrl('https://en.wikipedia.org/wiki/Test').include, ['#mw-content-text']);
  assert.ok(service.forUrl('https://developer.mozilla.org/en-US/docs/Web/JavaScript').include.includes('.main-page-content'));
});

test('损坏的已存订阅不影响本地有效规则，无Content-Length的超大响应被流式中止', async () => {
  const storage = area({ 'backend.rules': { version: 1, local: [rule('local-kept', 'https://kept.example/*')], subscriptions: [{ url: 'javascript:bad()', rules: [] }] } });
  let cancelled = false;
  const service = new RuleService({ storage, fetch: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); }, cancel() { cancelled = true; } })) });
  await service.ready(); assert.equal(service.forUrl('https://kept.example/a').id, 'local-kept');
  await service.subscribe('https://rules.example/too-large.json'); assert.equal(cancelled, true);
  assert.match(service.list().subscriptions[0].lastError, /上次有效/); assert.equal(service.forUrl('https://kept.example/a').id, 'local-kept');
});

test('订阅公开真实JSON版本且ETag独立，失败和304保留版本，回滚和重启同步恢复元数据', async () => {
  const url='https://rules.example/versioned.json', storage=area();let now=100, version='release-1', status=200;
  const service=new RuleService({storage,now:()=>now,fetch:async()=>status===304?new Response(null,{status:304}):status===500?new Response('',{status:500}):new Response(JSON.stringify({version,rules:[rule(version,'https://site.test/*')]}),{headers:{etag:`"etag-${version}"`}})});
  await service.subscribe(url);let info=service.list().subscriptions[0];
  assert.equal(info.version,'release-1');assert.equal(info.etag,'"etag-release-1"');assert.equal(info.updatedAt,100);
  now=200;status=500;await service.refresh();assert.equal(service.list().subscriptions[0].version,'release-1');
  const failed=new RuleService({storage});await failed.ready();assert.match(failed.list().subscriptions[0].lastError,/上次有效/);assert.equal(failed.list().subscriptions[0].version,'release-1');
  status=304;now=300;await service.refresh();info=service.list().subscriptions[0];assert.equal(info.version,'release-1');assert.equal(info.updatedAt,300);assert.equal(info.lastError,undefined);
  status=200;version='release-2';now=400;await service.refresh();assert.equal(service.list().subscriptions[0].version,'release-2');
  now=500;await service.rollback(url);info=service.list().subscriptions[0];assert.equal(info.version,'release-1');assert.equal(info.etag,undefined);assert.equal(info.updatedAt,500);
  const restored=new RuleService({storage});await restored.ready();assert.equal(restored.list().subscriptions[0].version,'release-1');await restored.rollback(url);assert.equal(restored.list().subscriptions[0].version,'release-2');
  assert.equal('previousVersion' in info,false);assert.equal('rules' in info,false);
});

test('无文档版本时用真实有效规则SHA256，格式变化不换版本，内容与回滚会换版本', async () => {
  const url='https://rules.example/array.json';let id='one', pretty=false;
  const service=new RuleService({storage:area(),fetch:async()=>new Response(JSON.stringify([rule(id,'https://site.test/*')],null,pretty?2:undefined),{headers:{etag:'"unchanged-http-tag"'}})});
  await service.subscribe(url);const first=service.list().subscriptions[0].version;assert.match(first,/^sha256:[0-9a-f]{64}$/);assert.notEqual(first,'"unchanged-http-tag"');
  pretty=true;await service.refresh();assert.equal(service.list().subscriptions[0].version,first);
  id='two';await service.refresh();assert.notEqual(service.list().subscriptions[0].version,first);await service.rollback(url);assert.equal(service.list().subscriptions[0].version,first);
});

test('首次失败没有虚构版本，错误跨重启保留；旧有效规则可无损补真实内容版本', async () => {
  const storage=area(),url='https://rules.example/failing.json';
  const service=new RuleService({storage,fetch:async()=>new Response('bad json')});await service.subscribe(url);
  assert.equal(service.list().subscriptions[0].version,null);assert.equal(service.list().subscriptions[0].updatedAt,undefined);
  const restarted=new RuleService({storage});await restarted.ready();assert.equal(restarted.list().subscriptions[0].version,null);assert.match(restarted.list().subscriptions[0].lastError,/上次有效/);
  const legacy=new RuleService({storage:area({'backend.rules':{version:1,local:[],subscriptions:[{url,rules:[rule('legacy','https://site.test/*')],etag:'"legacy-etag"',updatedAt:22,lastError:'旧更新失败'}]}})});
  await legacy.ready();const info=legacy.list().subscriptions[0];assert.match(info.version,/^sha256:/);assert.equal(info.etag,'"legacy-etag"');assert.equal(info.lastError,'旧更新失败');assert.equal(legacy.forUrl('https://site.test/a').id,'legacy');
});

test('本地保存兼容高级页裸域和子域通配，旧协议模式原样保留且规则实际命中', async () => {
  const storage=area(),service=new RuleService({storage,builtin:[]});
  const plain=await service.save(rule('plain','frontend21.example.test'));assert.deepEqual(plain.match,['*://frontend21.example.test/*']);
  assert.equal(service.forUrl('https://frontend21.example.test/article').id,'plain');assert.equal(service.forUrl('http://frontend21.example.test/').id,'plain');
  assert.equal(service.forUrl('https://frontend21.example.test.evil/'),null);
  const sub=await service.save(rule('sub','*.example.org'));assert.deepEqual(sub.match,['*://*.example.org/*']);
  assert.equal(service.forUrl('https://news.example.org/story').id,'sub');assert.equal(service.forUrl('http://a.b.example.org/').id,'sub');assert.equal(service.forUrl('https://example.org/'),null);
  const existing=['https://legacy.test/docs/*','*://legacy.test/*','file:///C:/papers/*'];
  const old=await service.save({...rule('legacy',existing[0]),match:existing});assert.deepEqual(old.match,existing);
  const restored=new RuleService({storage,builtin:[]});await restored.ready();assert.equal(restored.forUrl('https://frontend21.example.test/after-restart').id,'plain');
});

test('本地裸域支持真实localhost端口匹配、IDN及明确IP，并处理协议默认端口', async () => {
  const service=new RuleService({storage:area(),builtin:[]});
  const cases=[['local','localhost:8087','*://localhost:8087/*','http://localhost:8087/path'],['idn','例子.测试','*://xn--fsqu00a.xn--0zwm56d/*','https://例子.测试/path'],['ipv4','127.0.0.1:3000','*://127.0.0.1:3000/*','http://127.0.0.1:3000/path'],['ipv6','[::1]:3001','*://[::1]:3001/*','http://[::1]:3001/path']];
  for(const[id,host,pattern,url]of cases){const saved=await service.save(rule(id,host));assert.deepEqual(saved.match,[pattern]);assert.equal(service.forUrl(url).id,id);}
  assert.equal(service.forUrl('http://localhost:8088/path'),null);
  await service.save(rule('http-default','localhost:80'));assert.equal(service.forUrl('http://localhost:80/path').id,'http-default');assert.equal(service.forUrl('https://localhost:80/path').id,'http-default');
  await service.save(rule('https-default','localhost:443'));assert.equal(service.forUrl('https://localhost:443/path').id,'https-default');assert.equal(service.forUrl('http://localhost:443/path').id,'https-default');
});

test('本地网站简写拒绝凭据、路径、脚本、空白、编码绕过和危险通配，不写入规则', async () => {
  const service=new RuleService({storage:area(),builtin:[]});
  for(const host of ['user:password@example.com','example.com/path','example.com?query=1','example.com#fragment','example.com\\path',' example.com','example .com','javascript:alert(1)','javascript:80','data:text/html,hi','//example.com','*example.com','example.*','*','*.127.0.0.1','*.example.org:99999','localhost:0','localhost:bad','example%2ecom','127.1','0x7f000001','bad..example.com','-bad.example.com'])await assert.rejects(service.save(rule('unsafe',host)),(error)=>error.info.code==='bad_input',host);
  assert.deepEqual(service.exportLocal(),[]);
});

test('裸域兼容仅限人工save，订阅JSON和通用validateRule仍严格要求原协议模式', async () => {
  const host=rule('remote','example.com');assert.throws(()=>validateRule(host,'subscription'));
  const service=new RuleService({storage:area(),builtin:[],fetch:async()=>new Response(JSON.stringify([host]))});await service.subscribe('https://rules.example/bare.json');
  const info=service.list().subscriptions[0];assert.equal(info.count,0);assert.equal(info.version,null);assert.match(info.lastError,/上次有效/);assert.equal(service.forUrl('https://example.com/'),null);
});
