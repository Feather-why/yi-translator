# 整句和引用划选的后端修复及前端交接

## 本次处理范围

本次只修改对齐后端和相关测试。没有修改 `src/frontend/content/highlight.ts`、页面 DOM、核心翻译器、翻译端口或媒体代码。`AlignResult.spans` 的可选协议定义及交接记录由主代理统一维护。

用户给出的两类问题应分开验收：

- 引号内的 `Dynasty of the Country of the Sea` 误关联到引号外的 `Sealand`：后端词级链接已修复，新请求无需前端新策略即可使用修正后的链接。
- 选择 Babylon 整句时译文强高亮仍分散：后端提供独立的完整句子范围，并修复缺句号时跨到下一句的标点链接；旧前端尚未读取范围字段，连贯绘制整句仍需前端接入。没有用虚假的整句 token 或位置链接来掩盖词级缺失。

## 根因及后端行为

真实 E5 复现显示，Sealand 节选的引号内 `the / of` 被映到中文译文中保留的 Latin 专名 `Sealand`。英语虚词对中文的约束原本只检查汉字，误放过了这种混合文字情况。现在中文目标中的英语虚词只接受实际含义或同文词，不再连接到另一个 Latin 专名；其他目标语言的正常拉丁文字翻译保留原逻辑。

引号不是按第几个对第几个配。后端要求至少两个不同实词、两个目标词的真实链接支持，并且双方互为唯一最佳候选，才确认一对引用范围。截图中 `Dynasty→王朝 / Country→国 / Sea→海` 支持第一对引号；后面的 `“Sealand”` 不会抢走它。确认后，用同一份 E5 向量在边界内重新选择语义链接；词典候选也服从相同范围。引号开闭标记只匹配该引用的对应标记。证据不足、歧义或极端多引号段落不硬配。

Babylon 节选缺少中文句末标点时，常规分句会将下一句也并进来。后端只有在两句都存在足够独立内容词锚点、锚点顺序一致，并能确认下一句起首词的真实对应时才细分。截图样例借助已经存在的 `Babylon→巴比伦` 译词，识别下一次“巴比伦”的起点。找不到依据时保持保守句组，不按字符长度拆出假边界。

## 可选范围字段

```ts
spans?: {
  kind: 'sentence' | 'phrase';
  source: [number, number];
  target: [number, number];
}[];
```

两边均为输入纯文本的 UTF-16 半开区间 `[start,end)`，不是词下标，也不是占位符串或原始 HTML 的位置。`srcTokens / tgtTokens / links` 仍是真实词级数据，Alt 悬停或单词选择继续使用它们。

`sentence` 可以是一对多或多对一的句组。前端只有完整选中对应的源端句组时，才能把它作为整句范围使用；不能因为选区落在句组里，就把整个句组都标亮。`phrase` 是有真实锚点支持的引用内部范围，不包括引号本身。未返回某个范围表示证据不足，应继续用词级结果，不从空缺推断对应内容。

## 交给前端的接入事项

只读审查发现，当前 `LinkedHighlighter.link()` 没有将选择范围、方向或粒度发给后端，收到结果后只把选中词的 links 合并；`tokenRanges()` 仅合并间隔至多一个字符的词，因此缺少语义链接的字仍有空隙。它还无条件把整个 part 作为 `tx-link-soft`，后端不能主动改掉这层整段淡底色。

建议在前端按用户真实选区决定绘制方式：

1. 选择完整句子或句组时，匹配 `sentence.source`，连续绘制对应 `sentence.target`；反向选择则交换两端。应先去掉选区两端空白，并要求基本覆盖范围及相应句界，不能只看“有重叠”。
2. 完整选择引用内部短语时，使用匹配的 `phrase` 范围。只选引用里的一个词或半个短语，仍用词级链接；不能把“包含于 phrase”误当成“选择了整个 phrase”。
3. 多句选择只合并完整覆盖的句范围，选区两端的部分句子继续按词级处理。不得用整个段落或所有链接的最小/最大包围框代替这个判断。
4. Alt 悬停及单词选择保持真实词级范围。强高亮不能为填满整句而增加虚假词链接；淡底色可改成最小可信句/短语范围，其无对应证据时的呈现由前端明确处理。
5. 当前缓存键是 `segId|stage|target.length`，且缓存首次 RPC Promise。同长度编辑、模型首次回退或后端策略更新可能继续使用旧结果。建议纳入完整源/目标文本及后端版本，对编辑/重翻和失败或回退结果设置失效策略。仅后端更新无法清除一个已经存在于页面内存中的旧 Promise。

本次发布后需重载扩展并刷新原网页，以便新页面请求新结果；不宣称后端能替现有页面清掉旧前端缓存。

## 缓存与隐私

对齐策略版本为 `2026-11-selection-boundaries-v1`。普通结果、严格投影结果、在途合并和后台预计算均使用带版本的键，旧 Sealand 结果不会命中新策略。现有实现没有把词链接持久化到 IndexedDB；保留的是固定版本的 E5 权重缓存，不需要重下模型。敏感来源的本地处理、`noCache` 和有界等待语义保持原样。

## 验证结果

`align-selection.fixture.json` 中的两条用户截图节选来自用户提供的公开英文句子与中文转录；相邻干扰句明确标为合成上下文，未冒称完整截图原文。

真实固定 q8 E5 CPU 与本机 ECDICT 结果：

| 样例 | 修复前选中的目标词 | 修复后 | 独立范围 |
| --- | --- | --- | --- |
| Sealand 截图节选 | 海、国、王朝、Sealand | 海、之、国、王朝 | phrase 精确覆盖“海之国王朝” |
| Sealand 加前句干扰 | 海、国、王朝、Sealand | 海、之、国、王朝 | 不进入前句“地区”或后面的 Sealand |
| Babylon 缺句末标点 | 正确词仍有空隙，另误连下一句句号 | 词级空隙保留，跨界句号已移除 | 首句 target `[0,26)`，下一句从 26 开始 |

Sealand 的反向选区只对应 `Dynasty / of / Country / of / Sea`；没有越到引号外的 Sealand。三个小样本此次各约 22–67ms，不含权重首次加载，也不代替浏览器整页 P50。测试实际执行 E5 推理，复用已下载的固定权重，没有调用 GPU 翻译、假后端或在线翻译接口。

本次新增回归检查引用锚点、目标多一对/重排引号、虚词到 Latin 专名的错误、引号标记、词典边界、无标点句界、证据不足时保守处理、UTF-16、范围验证/缓存复制，以及策略版本失效。原 Phonetics concerns↔研究、acoustic↔声学、auditory↔听觉、三句 dog、重复术语及超过 254 tokens 长段的五份真实 E5 回归也通过。

复现命令：

```powershell
node --test tests/backend/align.test.mjs tests/backend/align-sentences.test.mjs tests/backend/align-selection.test.mjs
node tests/backend/align-selection-real-model.mjs
$env:ALIGN_MODEL_CACHE_DIR='../translate-next/work/align-model-cache'
node tests/backend/align-correctness-real-model.mjs
```

原始前后结果为 `work/alignment-selection-before.json`、`work/alignment-selection-after.json`，旧问题回归结果为 `work/alignment-correctness-real-model.json`。本轮不做浏览器/UI 验收，整句连续显示待前端消费 `spans` 后另测，不能将后端字段通过等同于前端体验已完整修好。
