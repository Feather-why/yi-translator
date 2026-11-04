import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { restoreMissingAtoms as restoreGatewayAtoms } from '../../gateway/placeholder-atoms.mjs';

const require = createRequire(import.meta.url);
const build = process.env.BACKEND_BUILD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.compiled');
const { restoreMissingAtoms: restoreBackendAtoms } = require(path.join(build, 'backend/placeholder-atoms.js'));
const restoreMissingAtoms = (source, target) => {
  const value = restoreBackendAtoms(source, target);
  assert.equal(restoreGatewayAtoms(source, target), value, '后台与独立网关恢复结果必须逐字符一致');
  return value;
};
const { validTranslation } = require(path.join(build, 'backend/validation.js'));
const without = text => text.replace(/<x\d+\/>/g, '');
function repaired(source, target) {
  const value = restoreMissingAtoms(source, target);
  assert.equal(typeof value, 'string'); assert.equal(validTranslation(source, value), true);
  assert.equal(without(value), without(target), '只插原子，保留目标文字与格式的原始字符');
  return value;
}

test('缺失x在原文相对位置恢复，已有合格译文原样返回', () => {
  assert.equal(repaired('前半<x0/>后半', '前文译文后文译文'), '前文译文<x0/>后文译文');
  assert.equal(restoreMissingAtoms('a<x0/>b', '甲<x0/>乙'), '甲<x0/>乙');
  assert.equal(restoreMissingAtoms('plain', '正文'), '正文');
});

test('原子在开头、结尾以及连续缺失时保留原文顺序', () => {
  assert.equal(repaired('<x4/>hello<x8/><x9/>', '你好'), '<x4/>你好<x8/><x9/>');
  assert.equal(repaired('<x0/><x1/><x2/>', ''), '<x0/><x1/><x2/>');
  assert.equal(repaired('<g0><x3/></g0><x8/>', '<g0></g0>'), '<g0><x3/></g0><x8/>');
});

test('现存原子为两端锚点，恢复内容不会越过锚点', () => {
  const source = 'L<x0/>前半<x1/>后半<x2/>R', target = '左<x0/>前文译文后文译文<x2/>右';
  assert.equal(repaired(source, target), '左<x0/>前文译文<x1/>后文译文<x2/>右');
});

test('嵌套组分别定位原子，不能把链接内的公式移到链接外', () => {
  const source = 'Before<g0>甲<x0/>乙<g1><x1/>丙</g1>丁<x2/></g0><x3/>after';
  const target = '之前<g0>甲乙<g1>丙</g1>丁</g0>之后';
  const value = repaired(source, target);
  assert.match(value, /<g0>[^<]*<x0\/>[^<]*<g1><x1\/>丙<\/g1>丁<x2\/><\/g0><x3\/>/);
});

test('不同组交换语序时，在对应组内部恢复而不是按全段百分比', () => {
  const source = '<g0>前半<x0/>后半</g0> and <g1>left<x1/>right</g1>';
  const target = '<g1>leftright</g1>与<g0>前文译文后文译文</g0>';
  const value = repaired(source, target);
  assert.match(value, /<g0>前文译文<x0\/>后文译文<\/g0>/);
  assert.ok(value.indexOf('<x1/>') < value.indexOf('</g1>'));
});

test('Unicode数学字母和斜体h原码点保留，不做NFKC/NFC或大小写替换', () => {
  const symbols = '𝑁𝒙ℎ𝟘𝔸𝕒𝙰𝚣';
  const target = `${symbols} e\u0301 全角Ａ\u00a0后半`;
  const value = repaired(`前半<x0/>后半${symbols}`, target);
  assert.equal(without(value), target);
  assert.ok(without(value).includes(symbols)); assert.ok(without(value).includes('e\u0301'));
  assert.notEqual(without(value), target.normalize('NFKC'));
});

test('整个数学字母区和组合字素不被插入位置切开', () => {
  const math = Array.from({ length: 0x400 }, (_, i) => String.fromCodePoint(0x1d400 + i)).join('');
  const target = `开始 ${math} e\u0301 👩🏽‍💻 🇸🇪 结束`;
  const value = repaired('<x0/>a<x1/>b<x2/>c<x3/>d<x4/>', target);
  const boundaries = new Set([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(target)].map(item => item.index));
  boundaries.add(target.length);
  let priorTokenLength = 0;
  for (const item of value.matchAll(/<x\d+\/>/g)) {
    assert.equal(boundaries.has(item.index - priorTokenLength), true, '不能插入代理对或组合字素中间');
    priorTokenLength += item[0].length;
  }
  assert.equal(without(value), target);
});

test('补位不会把拉丁词拆成两半，且保留换行空白', () => {
  const target = 'before\nextraordinary\t after';
  const value = repaired('a<x0/>b', target);
  assert.ok(value.includes('extraordinary')); assert.equal(without(value), target);
});

test('缺g、破损g、父子错位、重复和未知x不靠补位掩盖', () => {
  for (const [source, target] of [
    ['<g0>a<x0/></g0>', 'a'],
    ['<g0>a<x0/></g0>', '<g0>a'],
    ['<g0><g1>a<x0/></g1></g0>', '<g1><g0>a</g0></g1>'],
    ['<g0>a<x0/></g0><x1/>', '<g0>a<x1/></g0>'],
    ['a<x0/>b<x1/>', '甲<x0/><x0/>乙'],
    ['a<x0/>b', '甲<x8/>乙'],
    ['a<x0/>b', '甲</x0/>乙'],
    ['a<x0/>b', '甲<x0>乙'],
    ['a<x0/>b', '甲<x0 / >乙'],
    ['a<x0/>b', '甲&lt;x0/&gt;乙'],
    ['a<x0/>b', '甲<script>乙'],
    ['<g0>a<x0/>', '<g0>甲</g0>'],
    ['a<x0/>b<x0/>', '甲乙'],
  ]) assert.equal(restoreMissingAtoms(source, target), undefined, `${source} -> ${target}`);
});

test('缺失原子左右锚点互换或夹入其他组时拒绝猜测', () => {
  assert.equal(restoreMissingAtoms('<x0/>left<x1/>right<x2/>', '<x2/>甲乙<x0/>'), undefined);
  assert.equal(restoreMissingAtoms('<g0>A</g0>left<x0/>right<g1>B</g1><g2>C</g2>', '<g0>甲</g0><g2>丙</g2>译文<g1>乙</g1>'), undefined);
});

test('整块译文消失、只剩标记或原子源文的虚构解释不接受', () => {
  assert.equal(restoreMissingAtoms('Words<x0/> matter.', ''), undefined);
  assert.equal(restoreMissingAtoms('Outside<g0>Words<x0/></g0>', '外部<g0></g0>'), undefined);
  assert.equal(restoreMissingAtoms('<x0/>', 'This is an equation.'), undefined);
  assert.equal(restoreMissingAtoms('<x0/>', null), undefined);
});

test('仅译文重排现存原子且结构合法时，不改变它的原有顺序', () => {
  const target = '<x1/>乙<x0/>甲';
  assert.equal(restoreMissingAtoms('a<x0/>b<x1/>', target), target);
});

test('恢复幂等，连续多原子不会倒序或重复', () => {
  const source = `left${Array.from({ length: 50 }, (_, i) => `<x${i}/>`).join('')}right`;
  const target = '左边文字右边文字', first = repaired(source, target);
  assert.deepEqual([...first.matchAll(/<x(\d+)\/>/g)].map(match => Number(match[1])), Array.from({ length: 50 }, (_, i) => i));
  assert.equal(restoreMissingAtoms(source, first), first);
});
