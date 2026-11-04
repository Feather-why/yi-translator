import { BUILD_INFO } from './build-info';
import { PROTOCOL_VERSION, type AlignPair, type AlignResult } from '../shared/protocol';
import { onRpc, RpcError, type RpcHandlers } from '../shared/rpc';
import { hostMatches } from '../shared/settings';
import { sensitivePatterns, disposeSensitivePolicy } from './sensitive-policy';
import { HELPER_HINT, type LocalControl } from './local-control';
import { broadcastAlignmentReset } from './align-reset';
import { providerTemplates } from './provider-options';
import { ProviderError } from './providers/types';
import type { BackendCore } from './core';
import type { BackendServices } from './services';
import { exportVault, importVault } from './secrets-backup';
import type { ModelWarmupRequest, ModelWarmupResult, PerformanceSnapshot } from '../shared/backend-v2';

/** B1 先返回可验证的同词/数字对齐，跨语言模型在 B3 接入。 */
export function align(pair: AlignPair): AlignResult {
  const tokens = (text: string): [number, number][] => Array.from(text.matchAll(/[\p{L}\p{N}]+|[^\s]/gu), (match) => [match.index!, match.index! + match[0].length]);
  const srcTokens = tokens(pair.source);
  const tgtTokens = tokens(pair.target);
  const links: [number, number][] = [];
  for (let s = 0; s < srcTokens.length; s++) {
    const source = pair.source.slice(...srcTokens[s]!).toLowerCase();
    if (!/[\p{L}\p{N}]/u.test(source)) continue;
    for (let t = 0; t < tgtTokens.length; t++) if (source === pair.target.slice(...tgtTokens[t]!).toLowerCase()) links.push([s, t]);
  }
  return { id: pair.id, srcTokens, tgtTokens, links };
}

export async function sensitiveSender(sender: chrome.runtime.MessageSender) {
  if ((sender.tab as (chrome.tabs.Tab & { incognito?: boolean }) | undefined)?.incognito) return true;
  const address = sender.url ?? sender.tab?.url;
  if (!address) return false;
  try { return hostMatches(new URL(address).hostname, await sensitivePatterns()); } catch { return true; }
}

const adminNames = new Set(['performance:get', 'providers:save', 'providers:add', 'providers:remove', 'providers:models', 'dict:import', 'align:configure', 'rules:list', 'rules:subscriptions', 'rules:save', 'rules:remove', 'rules:subscribe', 'rules:refresh', 'rules:rollback', 'sync:configure', 'sync:run', 'secrets:export', 'secrets:import']);
const mediaNames = new Set(['ocr:image', 'subtitle:translate', 'pdf:translate', 'media:cancel', 'pdf:open', 'pdf:close']);
/** 来源身份由浏览器提供，页面不能借请求参数取消其他标签页/文档的任务。 */
function mediaOwner(sender: chrome.runtime.MessageSender) {
  return JSON.stringify([sender.id, sender.tab?.id ?? null, sender.frameId ?? null, (sender as chrome.runtime.MessageSender & { documentId?: string }).documentId ?? sender.url ?? null]);
}
export function isAdminSender(sender: chrome.runtime.MessageSender): boolean {
  const id = chrome.runtime.id;
  return !!id && sender.id === id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}
function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return !!chrome.runtime.id && sender.id === chrome.runtime.id;
}
export interface RuntimeDiagnostics { performance?: () => PerformanceSnapshot; warmup?: (request: ModelWarmupRequest) => Promise<ModelWarmupResult>; localControl?: LocalControl }
export function createRpcHandlers(core: BackendCore, services?: BackendServices, diagnostics: RuntimeDiagnostics = {}): RpcHandlers {
  const needServices = () => {
    if (!services) throw new ProviderError({ code: 'no_provider', message: '后台业务模块尚未初始化', retryable: true });
    return services;
  };
  const media = () => {
    const backend = needServices().media;
    if (!backend) throw new ProviderError({ code: 'no_provider', message: '多媒体处理模块尚未就绪', retryable: true });
    return backend;
  };
  const listSecrets = async () => [...new Set((await core.list()).filter((provider) => provider.id !== 'pseudo').map((provider) => provider.id).concat('align'))];
  const handlers: RpcHandlers = {
    'performance:get': () => {
      if (!diagnostics.performance) throw new ProviderError({ code: 'no_provider', message: '性能统计尚未初始化', retryable: true });
      return diagnostics.performance();
    },
    'models:warmup': async (request, sender) => {
      if (!request || !['hover', 'manual'].includes(request.reason) || Object.keys(request).some((key) => !['providerId', 'reason'].includes(key))
        || request.providerId !== undefined && (typeof request.providerId !== 'string' || !request.providerId.trim() || request.providerId.length > 128 || /[\u0000-\u001f\u007f]/u.test(request.providerId))) throw new ProviderError({ code: 'bad_input', message: '模型预热参数格式不正确', retryable: false });
      const allowed = request.reason === 'manual' ? isAdminSender(sender) : isExtensionSender(sender) && Number.isInteger(sender.tab?.id) && sender.tab!.id! >= 0 && !await sensitiveSender(sender);
      if (!allowed) throw new ProviderError({ code: 'auth', message: '此来源不允许唤醒本机模型', retryable: false });
      return diagnostics.warmup ? diagnostics.warmup(request) : { status: 'unsupported' };
    },
    'providers:warm': async (request, sender) => {
      if (!request || Object.keys(request).some((key) => key !== 'mode') || request.mode !== undefined && !['fast', 'accurate', 'combined'].includes(request.mode)) throw new ProviderError({ code: 'bad_input', message: '服务预热参数格式不正确', retryable: false });
      if (!isExtensionSender(sender) || !Number.isInteger(sender.tab?.id) || sender.tab!.id! < 0 || await sensitiveSender(sender)) throw new ProviderError({ code: 'auth', message: '此来源不允许唤醒本机模型', retryable: false });
      // mode仅为兼容前端提示；实际目标始终取已保存的本机配置，不触发云端、内置下载或对齐。
      await diagnostics.warmup?.({ reason: 'hover' });
      return { ok: true };
    },
    ping: () => ({ protocol: PROTOCOL_VERSION, backend: `${BUILD_INFO.version}-release`, buildId: BUILD_INFO.buildId }),
    'dict:lookup': ({ word, lang, targetLang }) => services ? services.dictionary.lookup(word,
      lang === 'auto' && /^[A-Za-z][A-Za-z'-]*$/.test(word) ? 'en' : lang, targetLang) : null,
    'align:get': async ({ pairs }, sender) => {
      if (!services) return pairs.map(align);
      const sensitive = await sensitiveSender(sender);
      return services.alignment.get(pairs, { noCache: sensitive, localOnly: sensitive });
    },
    'rules:forUrl': async ({ url }) => { if (!services) return null; await services.rules.ready(); return services.rules.forUrl(url); },
    explain: ({ text, context }) => core.explain(text, context),
    'providers:list': () => core.list(),
    'providers:templates': () => providerTemplates(),
    'local:autostart': async (request, sender) => {
      if (Object.keys(request).some((key) => key !== 'enable') || request.enable !== undefined && typeof request.enable !== 'boolean') throw new ProviderError({ code: 'bad_input', message: '本地模型开机启动参数无效', retryable: false });
      if (!isExtensionSender(sender) || request.enable !== undefined && !isAdminSender(sender)) throw new ProviderError({ code: 'auth', message: '开机启动设置只能由扩展设置页修改', retryable: false });
      if (!diagnostics.localControl) return { supported: false, enabled: false, canStart: false, hint: HELPER_HINT };
      return request.enable === undefined ? diagnostics.localControl.status() : diagnostics.localControl.autostart(request.enable);
    },
    'local:start': async (request, sender) => {
      if (request !== undefined) throw new ProviderError({ code: 'bad_input', message: '立即启动不接受路径、命令或其他参数', retryable: false });
      if (!isExtensionSender(sender)) throw new ProviderError({ code: 'auth', message: '本机启动请求必须来自本扩展', retryable: false });
      const result = diagnostics.localControl ? await diagnostics.localControl.start() : { ok: false, message: HELPER_HINT };
      if (result.ok) void core.probe('llamacpp').catch(() => undefined);
      return result;
    },
    'providers:save': ({ id, enabled, config, options, name }) => core.save(id, enabled, config, options, name),
    'providers:add': ({ template, name }) => core.add(template, name),
    'providers:remove': ({ id }) => core.remove(id),
    'providers:models': ({ id, endpoint, config }) => core.models(id, endpoint, config),
    'providers:test': ({ id, sourceLang, targetLang }, sender) => {
      // 引导页挂载即测试；保留真实结果，但不要把后台准备页弹到用户面前。
      const welcome = isAdminSender(sender) && new URL(sender.url!).hash.split('/')[0] === '#welcome';
      const direction = { ...(sourceLang !== undefined ? { sourceLang } : {}), ...(targetLang !== undefined ? { targetLang } : {}) };
      return welcome ? core.test(id, { ...direction, prepare: false }) : Object.keys(direction).length ? core.test(id, direction) : core.test(id);
    },
    'feedback:bad': ({ source, provider, sourceLang, targetLang }) => core.feedback(source, provider, sourceLang, targetLang),
    'tm:save': async ({ source, target, sourceLang, targetLang }, sender) => {
      const result = await core.saveMemory(sourceLang, targetLang, source, target, await sensitiveSender(sender));
      services?.sync.notifyChange(); return result;
    },
    'perf:report': ({ firstScreenMs }) => core.report(firstScreenMs),
    'ui:openOptions': async ({ tab }) => {
      if (tab && ['general', 'providers', 'status', 'welcome', 'advanced'].includes(tab)) await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${tab}`) });
      else await chrome.runtime.openOptionsPage();
      return { ok: true };
    },
    'backend:capabilities': () => needServices().capabilities(),
    'dict:import': async ({ csv }) => {
      if (typeof csv !== 'string' || csv.length > 20 * 1024 * 1024) throw new ProviderError({ code: 'bad_input', message: '词典 CSV 格式不正确或超过 20MB', retryable: false });
      const result = await needServices().dictionary.importCsv(csv);
      await broadcastAlignmentReset(); return { ok: true, entries: result.count };
    },
    'align:configure': (config) => needServices().configureAlignment(config),
    'rules:list': async () => { const rules = needServices().rules; await rules.ready(); return rules.all(); },
    'rules:subscriptions': async () => { const rules = needServices().rules; await rules.ready(); return rules.list().subscriptions; },
    'rules:save': async ({ rule }) => { await needServices().rules.save(rule); services!.sync.notifyChange(); return { ok: true }; },
    'rules:remove': async ({ id }) => { if (typeof id !== 'string') throw new ProviderError({ code: 'bad_input', message: '规则 ID 不正确', retryable: false }); await needServices().rules.remove(id); services!.sync.notifyChange(); return { ok: true }; },
    'rules:subscribe': async ({ url }) => {
      const result = await needServices().rules.subscribe(url);
      if (result.subscriptions.some((entry) => entry.url === url && entry.lastError)) throw new ProviderError({ code: 'network', message: '规则订阅更新失败，已保留上次有效版本', retryable: true });
      return { ok: true };
    },
    'rules:refresh': async ({ url }) => {
      const result = await needServices().rules.refresh(url);
      if (result.subscriptions.some((entry) => (!url || entry.url === url) && entry.lastError)) throw new ProviderError({ code: 'network', message: '规则更新失败，已保留上次有效版本', retryable: true });
      return { ok: true };
    },
    'rules:rollback': async ({ url }) => { await needServices().rules.rollback(url); return { ok: true }; },
    'sync:configure': (config) => needServices().configureSync(config),
    'sync:run': () => needServices().runSync(),
    'secrets:export': async ({ passphrase }) => ({ archive: JSON.stringify(await exportVault(core.getVault(), passphrase, await listSecrets())) }),
    'secrets:import': async ({ archive, passphrase }) => {
      if (typeof archive !== 'string' || archive.length > 4 * 1024 * 1024) throw new ProviderError({ code: 'bad_input', message: '密钥归档格式不正确或超过上限', retryable: false });
      let value: unknown; try { value = JSON.parse(archive); } catch { throw new ProviderError({ code: 'bad_input', message: '密钥归档不是有效 JSON', retryable: false }); }
      await importVault(core.getVault(), value, passphrase, await listSecrets()); if (services) await services.refresh(); else await core.refreshStoredState(); return { ok: true };
    },
    'ocr:image': async (request, sender) => media().ocr({ ...request, noCache: request.noCache === true || await sensitiveSender(sender) }, undefined, mediaOwner(sender)),
    'subtitle:translate': async (request, sender) => media().subtitles({ ...request, noCache: request.noCache === true || await sensitiveSender(sender) }),
    'pdf:translate': async (request, sender) => media().pdf({ ...request, noCache: request.noCache === true || await sensitiveSender(sender) }, undefined, mediaOwner(sender)),
    'media:cancel': (request, sender) => {
      const backend = media();
      if (!backend.cancel) throw new ProviderError({ code: 'no_provider', message: '当前后台不支持媒体取消', retryable: false });
      return backend.cancel(request, mediaOwner(sender));
    },
    'pdf:open': async (request, sender) => {
      const backend = media();
      if (!backend.openPdf) throw new ProviderError({ code: 'no_provider', message: '当前后台不支持 PDF 会话', retryable: false });
      return backend.openPdf({ ...request, noCache: request.noCache === true || await sensitiveSender(sender) }, mediaOwner(sender));
    },
    'pdf:close': (request, sender) => {
      const backend = media();
      if (!backend.closePdf) throw new ProviderError({ code: 'no_provider', message: '当前后台不支持 PDF 会话', retryable: false });
      return backend.closePdf(request, mediaOwner(sender));
    },
  };
  const wrapped: RpcHandlers = Object.create(null) as RpcHandlers;
  for (const [name, handler] of Object.entries(handlers)) {
    (wrapped as Record<string, unknown>)[name] = async (payload: never, sender: chrome.runtime.MessageSender) => {
      try {
        if (adminNames.has(name) && !isAdminSender(sender)) throw new ProviderError({ code: 'auth', message: '此管理操作只能由扩展自己的设置页面调用', retryable: false });
        if (mediaNames.has(name) && !isExtensionSender(sender)) throw new ProviderError({ code: 'auth', message: '多媒体请求必须来自本扩展', retryable: false });
        if (!['performance:get', 'ping', 'providers:list', 'providers:templates', 'local:start', 'backend:capabilities', 'rules:list', 'rules:subscriptions', 'sync:run'].includes(name)
          && (!payload || typeof payload !== 'object' || Array.isArray(payload))) throw new ProviderError({ code: 'bad_input', message: '请求参数格式不正确', retryable: false });
        return await handler!(payload, sender);
      }
      catch (error) { if (mediaNames.has(name) && error instanceof DOMException && error.name === 'AbortError') throw new RpcError({ code: 'cancelled', message: '媒体任务已取消', retryable: false }); if (error instanceof ProviderError) throw new RpcError(error.info); throw new RpcError({ code: 'internal', message: '后台处理失败，请检查本地存储和服务配置', retryable: true }); }
    };
  }
  return wrapped;
}
export function registerRpc(core: BackendCore, services?: BackendServices, diagnostics?: RuntimeDiagnostics) {
  const unregister = onRpc(createRpcHandlers(core, services, diagnostics));
  return () => { unregister(); disposeSensitivePolicy(); };
}
