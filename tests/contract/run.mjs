import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
let compiler;
try {
  compiler = process.env.TSC_PATH || require.resolve('typescript/lib/tsc.js');
} catch {
  console.error('缺少 TypeScript，请先安装项目依赖，或用 TSC_PATH 指定本地 tsc.js。');
  process.exit(1);
}

function run(args) {
  const child = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}

run([compiler, '-p', path.join(root, 'tests/contract/tsconfig.json')]);
const compiled = path.join(root, 'tests/.compiled');
mkdirSync(compiled, { recursive: true });
writeFileSync(path.join(compiled, 'package.json'), '{"type":"commonjs"}\n');
const files = ['contract', 'providers', 'backend'].flatMap((directory) => {
  const target = path.join(root, 'tests', directory);
  try {
    return readdirSync(target).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join(target, name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
});
run(['--test', ...files]);
