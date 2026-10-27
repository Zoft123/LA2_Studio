import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const name of ['regressions.mjs', 'crop.mjs', 'crop-app.mjs']) {
  const checks = fileURLToPath(new URL('./' + name, import.meta.url));
  const result = spawnSync(process.execPath, [checks], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.argv.length > 2) {
  const formats = fileURLToPath(new URL('./run.mjs', import.meta.url));
  const corpus = spawnSync(process.execPath, [formats, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(corpus.status ?? 1);
}
