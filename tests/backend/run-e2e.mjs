import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// 正式前端配真实后台与本机 HTTP 回放；假后端界面断言由独立 test:ui 负责。
process.env.EXT_DIR ||= path.join(root, '.output/chrome-mv3');
await import('./browser.mjs');
