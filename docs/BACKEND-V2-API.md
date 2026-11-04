# 后端 v2 接口接入说明

现有前端不需要迁移；v1 翻译端口、状态端口及原有 13 个 RPC 保持原语义。`ping` 现在报告协议 2 和后台 `0.2.2-alignment`。媒体及业务接口类型位于 `src/shared/backend-v2.ts`，项目当前服务设置页的可选字段和管理接口在 `src/shared/protocol.ts`；后者继承前者，供同一个 RPC 客户端使用。

## 调用和错误

在扩展自己的页面或内容脚本中使用已有的 `src/shared/rpc.ts` 客户端。浏览器原生消息格式同样可用：

```typescript
const reply = await chrome.runtime.sendMessage({
  rpc: 'subtitle:translate',
  payload: {
    videoId: 'example-video', sourceLang: 'en', targetLang: 'zh-CN',
    segments: [{ id: 's1', text: 'Hello.', startMs: 0, endMs: 1500 }],
    mode: 'fast', noCache: true,
  },
});
if (!reply.ok) throw new Error(reply.error.message);
const translated = reply.data.segments;
```

成功信封为 `{ok:true,data}`，失败为 `{ok:false,error:{code,message,retryable}}`。OCR 块、字幕行、PDF 段落的独立翻译失败写在结果项的 `error` 字段中，保留其他成功项。请同时检查信封错误和逐项错误。

## 接口索引

| RPC | 请求要点 | 返回 | 权限 |
|---|---|---|---|
| `backend:capabilities` | 无 payload | 词典、对齐、多媒体、同步状态 | 原有消息通道 |
| `providers:add` | `{template,name}` | 停用的新 `ProviderInfo` 实例 | 扩展自己的页面 |
| `providers:remove` | `{id}` | `{ok:true}`，仅可删除自定义实例 | 扩展自己的页面 |
| `providers:models` | `{id,endpoint?,config?}` | 模型 id 列表 | 扩展自己的页面 |
| `dict:import` | `{csv}` | `{ok:true,entries}` | 扩展自己的页面 |
| `align:configure` | `{enabled,remoteUrl?,token?}` | `{ok:true}` | 扩展自己的页面 |
| `rules:list` | 无 payload | `SiteRule[]` | 扩展自己的页面 |
| `rules:save` | `{rule:SiteRule}` | `{ok:true}` | 扩展自己的页面 |
| `rules:remove` | `{id}` | `{ok:true}` | 扩展自己的页面 |
| `rules:subscribe` | `{url}` | `{ok:true}` | 扩展自己的页面 |
| `rules:refresh` | `{url?}` | `{ok:true}` | 扩展自己的页面 |
| `rules:rollback` | `{url}` | `{ok:true}` | 扩展自己的页面 |
| `sync:configure` | `{enabled,url?,username?,password?,syncSecrets?,passphrase?}` | `{ok:true}` | 扩展自己的页面 |
| `sync:run` | 无 payload | `{ok:true}` | 扩展自己的页面 |
| `secrets:export` | `{passphrase}` | `{archive:string}` | 扩展自己的页面 |
| `secrets:import` | `{passphrase,archive:string}` | `{ok:true}` | 扩展自己的页面 |
| `ocr:image` | `url` 或 `dataUrl`；`translate?,sourceLang?,targetLang?,mode?,noCache?` | 图片尺寸、引擎、文字块、置信度、四边形、可选译文 | 本扩展页面/内容脚本 |
| `subtitle:translate` | 视频 id、逐行 id/文本/时间、源/目标语言 | 相同顺序/编号/时间的逐行译文 | 本扩展页面/内容脚本 |
| `pdf:translate` | `url` 或 `dataUrl`；源/目标语言、可选页码/模式/noCache | 文件 hash、页面、段落坐标和译文 | 本扩展页面/内容脚本 |

管理操作同时核对扩展 id 和扩展页面 URL，网页中的内容脚本不能管理同步、导入密钥或修改规则。媒体接口核对本扩展发送者；敏感站点和隐身窗口由后台强制 `noCache`，不能依靠传入 false 绕过。

## 接入约定

- 保留服务端返回的原始 `id`、坐标和时间，错误时保留原文；不要让模型产生超链接目标或字幕时间。
- OCR 原图坐标为像素；PDF 坐标以页面左上角为原点、scale=1；两种坐标系不要混用。
- OCR `translate` 默认 false，开启后必须提供 `targetLang`；字幕/PDF 必须给出有效源语言（可为 auto）和目标语言（不可为 auto）。
- 字幕按视频、OCR/PDF 按文件内容 hash 隔离翻译缓存；`noCache` 不读写缓存、译文记忆和同步。
- 同步默认关闭，密钥默认不参与同步；显式开启密钥同步必须设置口令。密钥字段掩码不用于显示/恢复明文。
- `backend:capabilities.media` 表示接口可用；不表示首次权重已经下载。对齐准备失败时先返回启发式结果，避免阻塞页面交互。
- 普通 RPC 没有跨消息 cancel id；内部 MediaService 支持 AbortSignal。前端取消界面时应丢弃过期响应，不声称已经中断正在执行的 ONNX 算子。

请求上限、模型来源、同步冲突行为和各接口的完整示例分别见 B3/B4/B5 专题文档。新增前端入口时仍需另行前端实现及界面验收。

当前设置页已经提供的高级服务表单由 `providers:list` 的 `editable` 字段决定显示项；`providers:save` 新增可选 `options/name`，`options` 提供时按整份替换，未提供则保留原值。实际支持范围、地址/密钥隔离和缓存失效见 `PROVIDER-OPTIONS.md`。
