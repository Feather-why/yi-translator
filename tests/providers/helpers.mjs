import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const requireCompiled = createRequire(import.meta.url);
const build = process.env.BACKEND_BUILD_DIR || fileURLToPath(new URL('../.compiled/', import.meta.url));
export const provider = (name) => requireCompiled(path.join(build, `backend/providers/${name}.js`)).default;
export const request = (texts = ['Hello <g0>world <g1>模型</g1></g0> <x0/>.']) => ({ texts, sourceLang: 'auto', targetLang: 'zh-CN' });
export function context(handler, config = {}) {
  const calls = [];
  return { calls, signal: new AbortController().signal, config, log: () => {}, fetch: async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  } };
}
export const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
