import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const { Dictionary, exchanges } = require('../.compiled/backend/dict/index.js');
const { parseEcDictCsv } = require('../.compiled/backend/dict/csv.js');
const rows = [
  { word: 'run', translation: 'v. 跑\\nn. 运行', definition: 'move quickly', exchange: 'p:ran/d:run/i:running/3:runs', tag: 'cet4 cet6', collins: 5, oxford: true },
  { word: 'apple', phonetic: 'æpl', translation: 'n. 苹果', exchange: 's:apples' },
  { word: 'running', translation: 'n. 跑步', exchange: '0:run' },
];

test('ECDICT CSV 正确解析引号内逗号、换行和双引号，而非按逗号粗切', () => {
  const csv = '\uFEFFword,phonetic,definition,translation,exchange,tag,collins,oxford\r\n"test",,"a ""quoted"", definition","n. 测试\nvt. 检验",s:tests,cet4,3,1\r\n';
  const [row] = parseEcDictCsv(csv);
  assert.equal(row.word, 'test'); assert.equal(row.definition, 'a "quoted", definition');
  assert.equal(row.translation, 'n. 测试\nvt. 检验'); assert.equal(row.collins, 3); assert.equal(row.oxford, true);
  assert.throws(() => parseEcDictCsv('word,translation\n"test,bad'), /引号/);
  assert.throws(() => parseEcDictCsv('wrong,headers\nhello,word'), /缺少/);
});

test('ECDICT exchange 支持过去式、过去分词、现在分词、单三、复数与词根', () => {
  assert.deepEqual(exchanges('0:run/p:ran/d:run/i:running/3:runs/s:runs/unknown:ignored'), {
    lemma: 'run', forms: { 过去式: 'ran', 过去分词: 'run', 现在分词: 'running', 第三人称单数: 'runs', 复数: 'runs' },
  });
});

test('离线查询通过 exchange 还原 running/ran/runs 与 apples，保留真实 ECDICT 字段', async () => {
  const dictionary = new Dictionary({ memory: true, entries: rows });
  for (const word of ['running', 'ran', 'runs']) {
    const result = await dictionary.lookup(word, 'en', 'zh-CN');
    assert.equal(result.lemma, 'run'); assert.deepEqual(result.translations, ['v. 跑', 'n. 运行']);
    assert.equal(result.forms.过去式, 'ran'); assert.equal(result.source, 'ecdict');
  }
  assert.equal((await dictionary.lookup(' APPLES ')).lemma, 'apple');
  assert.equal(await dictionary.lookup('not-in-dictionary'), null);
  assert.equal(await dictionary.lookup('run', 'ja', 'zh-CN'), null);
  assert.equal(await dictionary.lookup('run', 'en', 'de'), null);
});

test('外部导入 CSV 后查询不再覆盖为内置词典，缓存返回值不能修改词库', async () => {
  const dictionary = new Dictionary({ memory: true, fetch: () => { throw new Error('不应下载'); } });
  await dictionary.importCsv('word,translation,exchange\nhello,n. 你好,s:hellos\n');
  const first = await dictionary.lookup('hello'); first.translations.push('不应污染');
  assert.deepEqual((await dictionary.lookup('hello')).translations, ['n. 你好']);
  assert.equal((await dictionary.lookup('hellos')).lemma, 'hello'); assert.equal(dictionary.status().entries, 1);
  await assert.rejects(dictionary.import([{ word: 'bad' }]), /无效/);
});

test('发布包包含真实十万高频词，常见词查询中位数小于 20ms', async () => {
  const packed = JSON.parse(gunzipSync(await readFile(new URL('../../public/dict/ecdict-100k.json.gz', import.meta.url))).toString());
  assert.equal(packed.entries.length, 100000); assert.match(packed.source, /skywind3000\/ECDICT/);
  const dictionary = new Dictionary({ memory: true, entries: packed.entries.map((row) => ({ word: row[0], phonetic: row[1], translation: row[2], definition: row[3], exchange: row[4], tag: row[5], collins: Number(row[6]), oxford: row[7] === '1' })) });
  await dictionary.ready();
  assert.equal(dictionary.status().entries, 100000);
  for (const word of ['apple', 'run', 'running', 'translation', 'browser', 'computer', 'hello']) assert.ok((await dictionary.lookup(word))?.translations.length, word);
  const durations = [];
  for (let index = 0; index < 100; index++) { const start = performance.now(); await dictionary.lookup(index % 2 ? 'running' : 'translation'); durations.push(performance.now() - start); }
  assert.ok(durations.sort((a, b) => a - b)[50] < 20);
});
