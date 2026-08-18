#!/usr/bin/env node
/**
 * Linear CLI entrypoint.
 *
 * 开发模式默认：优先直接跑 TypeScript 源码（Node 类型剥离，>= 22.6），
 * 改 src/ 里的代码立刻生效，无需 build、无需任何额外步骤。
 *
 * 兜底/备选：
 *   - Node < 22.6（不支持类型剥离）→ 自动回退 dist/ 编译产物（先 npm run build）；
 *   - 显式 `LINEAR_USE_DIST=1` → 强制走 dist/（如验证发布物行为）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcEntry = join(root, 'src', 'cli.ts');
const distEntry = join(root, 'dist', 'cli.js');

const [maj, min] = process.versions.node.split('.').map(Number);
// 类型剥离：22.6 引入；23.6 起默认启用（无需 flag）。
const canStripTypes = maj > 22 || (maj === 22 && min >= 6);
const needsStripFlag = !(maj > 23 || (maj === 23 && min >= 6));
const forceDist = process.env.LINEAR_USE_DIST === '1';

const [node, ...rest] = process.argv;
const args = rest.slice(1);

let entry;
let execArgv = [];
if (forceDist && existsSync(distEntry)) {
  entry = distEntry;
} else if (canStripTypes && existsSync(srcEntry)) {
  entry = srcEntry;
  execArgv = needsStripFlag ? ['--experimental-strip-types'] : [];
} else if (existsSync(distEntry)) {
  entry = distEntry;
} else {
  process.stderr.write(
    'linear: no runnable CLI found.\n' +
      '  Source mode needs Node >= 22.6; otherwise run `npm run build` first.\n',
  );
  process.exit(1);
}

const result = spawnSync(node, [...execArgv, entry, ...args], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
