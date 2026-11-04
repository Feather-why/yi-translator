interface OffscreenApi {
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  hasDocument?(): Promise<boolean>;
}
let creation: Promise<void> | undefined;

async function ensureOffscreen() {
  const offscreen = (chrome as typeof chrome & { offscreen?: OffscreenApi }).offscreen;
  if (!offscreen) throw new Error('当前浏览器不支持 offscreen 文档');
  if (offscreen.hasDocument && await offscreen.hasDocument()) return;
  creation ??= offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: '在 CPU 上运行本地词对齐，避免阻塞网页和占用翻译显存' }).finally(() => { creation = undefined; });
  await creation;
}

export async function offscreenRequest<T>(task: string, payload: unknown, timeoutMs = 180000): Promise<T> {
  await ensureOffscreen();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      chrome.runtime.sendMessage({ target: 'tx-offscreen', task, payload }) as Promise<{ ok: boolean; data?: T; error?: string }>,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('本地模型处理超时')), timeoutMs); }),
    ]);
    if (!result?.ok) throw new Error(result?.error ?? '本地模型不可用');
    return result.data as T;
  } finally { if (timer) clearTimeout(timer); }
}
