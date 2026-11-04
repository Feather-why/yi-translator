/**
 * RPC 的收发工具，前后端共用。
 *
 * 前端：  const entry = await rpc('dict:lookup', { word, lang, targetLang });
 * 后端：  onRpc({ 'dict:lookup': async (p, sender) => lookup(p), ... });
 *
 * 线上格式：chrome.runtime.sendMessage({ rpc, payload }) → { ok, data } | { ok:false, error }
 */
import type { ContentCommand, ErrorInfo, RpcMap, RpcName, RpcRequest, RpcResponse } from './protocol';

export class RpcError extends Error {
  constructor(public info: ErrorInfo) {
    super(info.message);
    this.name = 'RpcError';
  }
}

/** 发起一次 RPC；后端返回 ok:false 时抛 RpcError。 */
export async function rpc<K extends RpcName>(name: K, payload: RpcMap[K]['req']): Promise<RpcMap[K]['res']> {
  const req: RpcRequest<K> = { rpc: name, payload };
  let res: RpcResponse<K> | undefined;
  try {
    res = await chrome.runtime.sendMessage(req);
  } catch (e) {
    throw new RpcError({ code: 'internal', message: '后台未响应：' + String((e as Error)?.message ?? e), retryable: true });
  }
  if (!res) throw new RpcError({ code: 'internal', message: `后台没有实现 ${name}`, retryable: false });
  if (!res.ok) throw new RpcError(res.error);
  return res.data;
}

export type RpcHandlers = {
  [K in RpcName]?: (payload: RpcMap[K]['req'], sender: chrome.runtime.MessageSender) => Promise<RpcMap[K]['res']> | RpcMap[K]['res'];
};

export function isRpcRequest(msg: unknown): msg is RpcRequest {
  return !!msg && typeof msg === 'object' && typeof (msg as any).rpc === 'string';
}

export function isContentCommand(msg: unknown): msg is ContentCommand {
  return !!msg && typeof msg === 'object' && typeof (msg as any).cmd === 'string';
}

/** 后端用：注册 RPC 处理函数。未注册的 RPC 不回应，让别的监听器处理。 */
export function onRpc(handlers: RpcHandlers): () => void {
  const listener = (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: RpcResponse) => void) => {
    if (!isRpcRequest(msg)) return false;
    const fn = handlers[msg.rpc] as ((p: unknown, s: chrome.runtime.MessageSender) => unknown) | undefined;
    if (!fn) return false;
    Promise.resolve()
      .then(() => fn(msg.payload, sender))
      .then(
        (data) => sendResponse({ ok: true, data } as RpcResponse),
        (e) =>
          sendResponse({
            ok: false,
            error:
              e instanceof RpcError
                ? e.info
                : { code: 'internal', message: String((e as Error)?.message ?? e), retryable: false },
          }),
      );
    return true; // 异步回应
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/** 生成短 id：时间 + 随机。 */
export function uid(prefix = ''): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
