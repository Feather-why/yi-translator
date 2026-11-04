import { PORT_STATUS, PORT_TRANSLATE } from '../shared/protocol';
import { BackendCore } from './core';
import { providers } from './providers/registry';
import { TranslatePort } from './ports/translate';
import { StatusPort } from './ports/status';
import { registerRpc, sensitiveSender } from './rpc';
import { MeasuredQueue, PerformanceMetrics } from './performance';
import { ModelWarmup } from './model-warmup';
import { NativeLocalControl } from './local-control';
import { pseudo } from './pseudo';
import { BackendServices } from './services';
import { MediaService } from './media';
import { stripPlaceholders } from '../shared/placeholders';
import { createBrowserTranslatorBridge } from './browser-translator-bridge';
import { createBuiltinSetupOpener } from './builtin-setup';

export function startBackend(options: { development?: boolean } = {}) {
  let services: BackendServices;
  const performanceMetrics = new PerformanceMetrics();
  const localControl = new NativeLocalControl();
  // 与现有前端 buildMap 相同地折叠空白，使译后预计算能复用于划选请求。
  const visibleText = (text: string) => stripPlaceholders(text).replace(/\s+/gu, ' ').replace(/^ /, '');
  const core = new BackendCore({ providers: options.development ? [...providers, pseudo] : providers,
    onPerformance: (event) => performanceMetrics.record(event),
    onPlaceholderDiagnostic: (event) => performanceMetrics.record({ ...event, type: 'placeholder' }),
    builtin: createBrowserTranslatorBridge(),
    openBuiltinSetup: createBuiltinSetupOpener(),
    onTranslated: (job, segment, text) => {
      if (!services || job.noCache || job.priority > 1) return;
      void services.alignment.precompute({ id: segment.id, source: visibleText(segment.text), target: visibleText(text),
        sourceLang: job.sourceLang, targetLang: job.targetLang });
    },
    align: async (pair, signal) => {
      if (!services || signal.aborted) return undefined;
      // 只使用有界的本地结果；标签恢复不等待首次下载，不上传也不持久化原文。
      try {
        const result = await services.alignment.projection(pair, 350, { noCache: true });
        return signal.aborted ? undefined : result;
      } catch { return undefined; }
    },
    lookup: async (word, sourceLang, targetLang) => {
      if (!services?.dictionary.status().ready) return null;
      return services.dictionary.lookup(word, sourceLang, targetLang);
    },
    syncStatus: () => services ? services.sync.status() : undefined,
  });
  services = new BackendServices(core, {
    schedule: async (when) => { await chrome.alarms.clear('tx-sync'); if (when !== undefined) await chrome.alarms.create('tx-sync', { when }); },
    onStatus: () => core.notifyStatus(),
  });
  services.media = new MediaService({ translate: (job, segment, tier, signal) => core.translate(job, segment, tier, signal) });
  const queue = new MeasuredQueue((event) => performanceMetrics.record(event), 32);
  const warmup = new ModelWarmup({ provider: async (requested) => {
    const candidates = await core.list();
    const statuses = core.snapshot().providers;
    const local = (candidate: typeof candidates[number]) => candidate.kind === 'local' && (candidate.id === 'llamacpp' || candidate.template === 'llamacpp');
    const provider = requested ? candidates.find((candidate) => candidate.id === requested) : candidates.find((candidate) => local(candidate) && candidate.enabled && candidate.configured && statuses.find((entry) => entry.id === candidate.id)?.health !== 'disabled');
    if (!provider || !local(provider)) return undefined;
    const status = statuses.find((candidate) => candidate.id === provider.id);
    const secrets = provider.enabled && provider.configured && status?.health !== 'disabled' ? await core.getVault().get(provider.id) : {};
    return { id: provider.id, kind: provider.kind, adapter: provider.template ?? provider.id, enabled: provider.enabled, configured: provider.configured,
      paused: status?.health === 'disabled', endpoint: provider.options?.endpoint ?? provider.config.url ?? provider.defaults?.endpoint ?? '', apiKey: secrets.key };
  } });
  const ports = new Set<{ dispose(): void }>();
  // 监听器必须在 service worker 的同步启动阶段注册，避免唤醒消息丢失。
  const connect = (port: chrome.runtime.Port) => {
    let handler: TranslatePort | StatusPort | undefined;
    if (port.name === PORT_TRANSLATE) handler = new TranslatePort(port, {
      translate: async (job, segment, tier, signal, observer) => core.translate(
        await sensitiveSender(port.sender ?? {}) ? { ...job, noCache: true } : job, segment, tier, signal, observer),
      createCombined: async (job, segment) => core.createCombined(await sensitiveSender(port.sender ?? {}) ? { ...job, noCache: true } : job, segment),
    }, 32, queue);
    else if (port.name === PORT_STATUS) handler = new StatusPort(port, core);
    if (handler) {
      ports.add(handler);
      const current = handler;
      port.onDisconnect.addListener(() => ports.delete(current));
    }
  };
  chrome.runtime.onConnect.addListener(connect);
  const unregister = registerRpc(core, services, { performance: () => performanceMetrics.snapshot(), warmup: (request) => warmup.warmup(request), localControl });
  const alarm = (value: chrome.alarms.Alarm) => {
    if (value.name === 'tx-sync') void services.runSync().catch(() => undefined);
    else if (value.name === 'tx-rules') void services.rules.refresh().catch(() => undefined);
    else if (value.name === 'tx-probe') void core.probe().catch(() => undefined);
  };
  chrome.alarms.onAlarm.addListener(alarm);
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && Object.hasOwn(changes, 'settings.core')) void core.refreshPolicy().catch(() => undefined);
    if (area === 'local' && ['settings.ui', 'settings.core', 'backend.rules', 'backend.usage'].some((key) => Object.hasOwn(changes, key))) services.sync.notifyChange();
  };
  chrome.storage.onChanged.addListener(changed);
  // 初始化错误会出现在真实状态中，不让一次存储失败变成未处理的拒绝。
  void core.ready().then(() => core.probe()).catch(() => undefined);
  void services.ready().then(async () => {
    for (const [name, periodInMinutes] of [['tx-rules', 1440], ['tx-probe', 30]] as const) {
      if (!await chrome.alarms.get(name)) await chrome.alarms.create(name, { periodInMinutes });
    }
    await services.rules.refresh();
    if (services.sync.status().enabled) await services.runSync();
  }).catch(() => undefined);
  return { core, services, dispose() { localControl.dispose(); warmup.dispose(); unregister(); chrome.runtime.onConnect.removeListener(connect); chrome.alarms.onAlarm.removeListener(alarm);
    chrome.storage.onChanged.removeListener(changed); for (const port of ports) port.dispose(); ports.clear(); void services.dispose(); } };
}
