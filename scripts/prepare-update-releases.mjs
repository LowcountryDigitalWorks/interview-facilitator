import { spawnSync } from 'node:child_process';
import path from 'node:path';

const viteBin = path.resolve('node_modules/vite/bin/vite.js');
for (const release of ['release-a', 'release-b']) {
  const result = spawnSync(process.execPath, [viteBin, 'build'], {
    env: { ...process.env, APP_RELEASE: release, BUILD_OUT: path.resolve(`dist-${release}`) },
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
