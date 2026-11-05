import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../../src/frontend/media/pixels.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const context = vm.createContext({exports:{}});
vm.runInContext(compiled, context);

test('blob JPEG 保留原有压缩、已撤销地址可走 PNG，取消后跳过画布工作', async () => {
  const jpeg = new Blob([new Uint8Array([0xff,0xd8,0xff,0xd9])], {type:'image/jpeg'});
  const png = new Blob([new Uint8Array([1,2,3])], {type:'image/png'});
  let draws = 0;
  const canvas = {width:0,height:0,getContext:()=>({drawImage(){ draws++; }}),toBlob: callback => queueMicrotask(()=>callback(png))};
  context.document = {createElement:()=>canvas};
  context.FileReader = class {
    async readAsDataURL(blob) {
      this.result = 'data:' + blob.type + ';base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64');
      this.onload();
      this.onloadend();
    }
  };
  const encode = context.exports.blobImageDataUrl;
  const img = {naturalWidth:64,naturalHeight:64};
  const signal = new AbortController().signal;
  context.fetch = async () => ({ok:true,blob:async()=>jpeg});
  assert.equal(await encode(img, 'blob:fixture', signal), 'data:image/jpeg;base64,/9j/2Q==');
  assert.equal(draws,0);
  context.fetch = async () => { throw Error('revoked URL'); };
  assert.equal(await encode(img, 'blob:revoked', signal), 'data:image/png;base64,AQID');
  assert.equal(draws,1);
  assert.equal(canvas.width,0);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(encode(img, 'blob:revoked', cancelled.signal), {name:'AbortError'});
  assert.equal(draws,1);
});

test('OCR 取色保留四分位颜色的稳定次序、背景中位数和边界附近的墨水比例', () => {
  const image = {width:12, height:8, scale:1, data:new Uint8ClampedArray(12*8*4).fill(255)};
  const colors = [[0,15,30], [30,0,15], [15,30,0], [80,70,60], [23,45,30]];
  let index = 0;
  for (let y=1;y<=6;y++) for (let x=2;x<=9;x++) {
    image.data.set(colors[index++ % colors.length], (y*12+x)*4);
  }
  const crop = context.exports.sampleBox(image,-3.3,-1.2,9.2,6);
  assert.deepEqual(Array.from(crop.bg), [255,255,255]);
  assert.deepEqual(Array.from(crop.fg), [15,15,15]);
  assert.equal(crop.ink, 48/70);
  assert.equal(context.exports.sampleBox(image,2,1,9,6).ink,1);
});

test('OCR 取色仅检查边界以内的采样点，超出画面的框能及时返回', () => {
  context.image = {width:16,height:16,scale:1,data:new Uint8ClampedArray(16*16*4).fill(255)};
  const result = vm.runInContext('exports.sampleBox(image, -1e9, 2, 1e9, 12)', context, {timeout:1000});
  assert.equal(result.ink, 0);
  assert.deepEqual(Array.from(result.fg),[24,24,28]);
});
