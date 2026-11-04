import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { filesWithin } from './optimize-assets.mjs';

export async function prepareBuildInfo(root) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const hash = createHash('sha256');
  const names = ['package.json', 'package-lock.json', 'wxt.config.ts'];
  for (const dir of ['src', 'gateway/scripts', 'public/_locales']) {
    for (const file of await filesWithin(path.join(root, dir))) names.push(`${dir}/${file}`);
  }
  for (const name of names.sort()) {
    if (name === 'src/backend/build-info.ts') continue;
    hash.update(name).update('\0').update(await readFile(path.join(root, name))).update('\0');
  }
  const sourceDigest = hash.digest('hex');
  const info = { version: pkg.version, buildId: `${pkg.version}-${sourceDigest.slice(0, 12)}`, sourceDigest, builtAt: new Date().toISOString() };
  await mkdir(path.join(root, 'public'), { recursive: true });
  await writeFile(path.join(root, 'public/build-info.json'), JSON.stringify(info, null, 2) + '\n');
  await writeFile(path.join(root, 'src/backend/build-info.ts'), `// 构建时生成，版本来源只有 package.json。\nexport const BUILD_INFO = ${JSON.stringify(info, null, 2)} as const;\n`);
  return info;
}
