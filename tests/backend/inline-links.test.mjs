import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// 用实际序列化入口处理文本节点。VM 的超时也能中止一次过慢的同步正则调用。
async function compile(name) {
  const file = new URL('../../src/frontend/content/' + name + '.ts', import.meta.url);
  return ts.transpileModule(await readFile(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

const context = vm.createContext({ exports: {} });
const [domCode, mappingsCode, serializeCode] = await Promise.all([compile('dom'), compile('text-runs'), compile('serialize')]);
vm.runInContext(domCode, context);
const dom = context.exports;
context.exports = {};
vm.runInContext(mappingsCode, context);
const mappings = context.exports;
context.require = name => {
  if (name === './text-runs') return mappings;
  assert.equal(name, './dom');
  return dom;
};
context.exports = {};
vm.runInContext(serializeCode, context);
const run = new vm.Script('exports.serialize([{ nodeType: 3, data: input }])');
function serialize(input) {
  context.input = input;
  return run.runInContext(context, { timeout: 3000 });
}

test('网页纯文本链接保留网址、邮箱、相邻标点及 UTF-16 位置', () => {
  const source = '𝒙 联系 qa+test@dept.example.co.uk，参见 (https://example.org/a?x=1), 和 prefix.www.example.org/page。';
  const result = serialize(source);
  assert.equal(result.text, '𝒙 联系 <x0/>，参见 (<x1/>), 和 prefix.<x2/>。');
  assert.deepEqual(Array.from(result.slots, slot => slot.url), [
    'qa+test@dept.example.co.uk', 'https://example.org/a?x=1', 'www.example.org/page',
  ]);
  for (const slot of result.slots) {
    assert.equal(slot.kind, 'u');
    assert.equal(source.slice(slot.end - slot.url.length, slot.end), slot.url);
  }
  assert.equal(serialize('a@b.co+next@d.io').text, '<x0/><x1/>');
  assert.equal(serialize('www.example.org/a@b.com').text, '<x0/>');
});

test('长正文按原文连续位置保存，空白折叠与网址前后的 UTF-16 位置准确', () => {
  const lead = 'long text '.repeat(100_000);
  const raw = '  ' + lead + '\t\r\n' + '𝒙 https://example.org/path text';
  const s = serialize(raw);
  assert.equal(s.text, lead + '𝒙 <x0/> text');
  assert.ok(s.pos.length <= 5, '连续文本无需按字符创建位置对象');
  for (const sample of ['long', '𝒙', ' text']) {
    const offset = sample === ' text' ? s.text.lastIndexOf(sample) : s.text.indexOf(sample);
    const entry = s.pos.find(r => r.start <= offset && offset < r.end);
    assert.ok(entry);
    const at = entry.offset + offset - entry.start;
    assert.equal(raw.slice(at, at + sample.length), sample);
  }
  const placeholder = s.text.indexOf('<x0/>');
  assert.equal(s.pos.some(r => r.start <= placeholder && placeholder < r.end), false);
});

test('长标识符、畸形域名和连续 @ 不阻塞后续有效邮箱的占位符生成', () => {
  const run = 'X'.repeat(128 * 1024);
  const prefix = run + ' bad@' + run + ' ' + run + '@@broken@localhost ';
  const result = serialize(prefix + 'ok@example.org.');
  assert.equal(result.slots.length, 1);
  assert.equal(result.slots[0].url, 'ok@example.org');
  assert.equal(result.text, prefix + '<x0/>.');
});
