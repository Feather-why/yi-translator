/**
 * 运行在 YouTube 页面自己的环境（MAIN world）里：包一层 fetch 和 XMLHttpRequest，
 * 播放器自己请求字幕（/api/timedtext，带 PoToken）时，把返回内容转交给内容脚本。
 * 只读不改：请求和响应都原样交还给播放器。这里拿不到扩展 API，只能用 postMessage。
 */
export const YT_MESSAGE = '__tx_yt_timedtext';

export function installYoutubeHook(): void {
  const w = window as unknown as { __txYtHook?: boolean };
  if (w.__txYtHook) return;
  w.__txYtHook = true;

  const isTimedText = (u: unknown): u is string => typeof u === 'string' && u.includes('/api/timedtext');
  const post = (url: string, body: string) => {
    if (body) window.postMessage({ [YT_MESSAGE]: true, url, body }, location.origin);
  };

  const origFetch = window.fetch;
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    const p = origFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (isTimedText(url)) {
        void p.then((res) => res.clone().text().then((t) => post(url, t))).catch(() => {});
      }
    } catch {
      /* 不影响原请求 */
    }
    return p;
  } as typeof fetch;

  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  proto.open = function (this: XMLHttpRequest & { __txUrl?: string }, ...args: unknown[]) {
    this.__txUrl = String(args[1]);
    return (origOpen as (...a: unknown[]) => void).apply(this, args);
  } as typeof proto.open;
  proto.send = function (this: XMLHttpRequest & { __txUrl?: string }, ...args: unknown[]) {
    if (isTimedText(this.__txUrl)) {
      this.addEventListener('load', () => {
        try {
          const body =
            this.responseType === '' || this.responseType === 'text'
              ? this.responseText
              : typeof this.response === 'string'
                ? this.response
                : JSON.stringify(this.response);
          post(this.__txUrl!, body);
        } catch {
          /* 忽略 */
        }
      });
    }
    return (origSend as (...a: unknown[]) => void).apply(this, args);
  } as typeof proto.send;
}
