import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

// 在独立浏览器文档运行与产品相同的模块，按实际 DOM 写入次数验证预算，避免把机器速度写进断言。
async function loadModule(page, source) {
  const text = await readFile(new URL('../../src/frontend/' + source, import.meta.url), 'utf8');
  const {outputText} = ts.transpileModule(text, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  });
  await page.addScriptTag({content: `window.testModule = {}; (function(exports){${outputText}})(window.testModule);`});
}

export async function checkRenderPressure(ctx, step) {
  await step('综合模式使用的定格动画在整批译文到达时只动画部分文字，保留所有译文和链接', async () => {
    const page = await ctx.newPage();
    try {
      await page.emulateMedia({reducedMotion: 'no-preference'});
      await loadModule(page, 'ui/scramble.ts');
      const result = await page.evaluate(() => {
        const items = [];
        for (let i = 0; i < 256; i++) {
          const item = document.createElement('div');
          item.innerHTML = '<a href="#read">阅读全文</a>，' + '这里保留完整译文。'.repeat(12);
          document.body.append(item);
          items.push(item);
        }
        let frame;
        window.requestAnimationFrame = callback => { frame = callback; return 1; };
        const original = items.map(item => item.innerHTML);
        const observer = new MutationObserver(() => {});
        observer.observe(document.body, {subtree: true, characterData: true});
        for (const item of items) testModule.revealText(item, 'zh');
        frame(performance.now() + 2);
        const touched = new Set(observer.takeRecords().map(r => r.target.parentElement.closest('div'))).size;
        for (const item of items.slice(0, 3)) testModule.finishReveal(item);
        frame(performance.now() + 1000);
        observer.takeRecords();
        testModule.revealText(items.at(-1), 'zh');
        frame(performance.now() + 2);
        const budgetReused = observer.takeRecords().length > 0;
        testModule.finishReveal(items.at(-1));
        observer.disconnect();
        return {touched, budgetReused, exact: items.every((item,i) => item.innerHTML === original[i])};
      });
      assert.ok(result.touched > 0 && result.touched < 256, '要保留动画，同时让大批译文及时显示');
      assert.ok(result.exact && result.budgetReused, '动画结束后应保留全部原样链接和译文，并释放预算');
    } finally { await page.close(); }
  });

  await step('密集等待提示轮流更新，停止后不再写入文字', async () => {
    const page = await ctx.newPage();
    try {
      await page.emulateMedia({reducedMotion: 'no-preference'});
      await loadModule(page, 'ui/scramble.ts');
      const stats = await page.evaluate(async () => {
        document.body.style.cssText = 'display:grid;grid-template-columns:repeat(16,1fr)';
        const items = Array.from({length:96}, () => document.body.appendChild(document.createElement('div')));
        const seen = new Set();
        let largestBatch = 0;
        let afterStop = 0;
        let stopped = false;
        const complete = new Promise((resolve,reject) => {
          const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('部分可见提示没有更新')); }, 4000);
          const observer = new MutationObserver(records => {
            if (stopped) { afterStop += records.length; return; }
            const changed = new Set(records.map(record => record.target));
            for (const node of changed) seen.add(node);
            largestBatch = Math.max(largestBatch, changed.size);
            if (seen.size === items.length) {
              stopped = true;
              clearTimeout(timeout);
              for (const item of items) testModule.stopScramble(item);
              setTimeout(() => { observer.disconnect(); resolve(); }, 150);
            }
          });
          observer.observe(document.body, {subtree:true, characterData:true});
        });
        for (const item of items) testModule.startScramble(item, 4, 'zh');
        await complete;
        return {largestBatch, afterStop};
      });
      assert.ok(stats.largestBatch > 0 && stats.largestBatch < 96);
      assert.equal(stats.afterStop, 0);
    } finally { await page.close(); }
  });

  await step('长文档的小节导航按文档次序识别，嵌套目录和不相关导航正确区分', async () => {
    const page = await ctx.newPage();
    try {
      await loadModule(page, 'content/main-content.ts');
      const result = await page.evaluate(() => {
        const main = document.createElement('main');
        document.body.append(main);
        const links = '<a href="#s0">First</a><a href="#s1">Previous</a><a href="#s2">Next</a>';
        for (let i=0; i<160; i++) {
          const section = document.createElement('section');
          section.id = 's' + i;
          section.innerHTML = '<nav>' + links + '<nav>' + links + '</nav></nav><p>Public function reference.</p>';
          main.append(section);
        }
        const other = document.createElement('nav');
        other.innerHTML = '<a href="/elsewhere">Another site</a>';
        document.body.prepend(other);
        const contains = Node.prototype.contains;
        let tests = 0;
        Node.prototype.contains = function(node){ tests++; return contains.call(this, node); };
        try {
          const scope = testModule.detectContent();
          const filter = testModule.scopeFilter(scope);
          const accepted = [...main.querySelectorAll('a,p')].every(el => filter(el) === 2);
          return {directories: Array.from(scope.extra).length, accepted, other: filter(other), tests};
        } finally { Node.prototype.contains = contains; }
      });
      assert.equal(result.directories, 160);
      assert.ok(result.accepted);
      assert.equal(result.other, 0);
      assert.ok(result.tests < 8000, `过滤不应将每个元素与所有目录逐一比对，实测 ${result.tests} 次`);
    } finally { await page.close(); }
  });
}
