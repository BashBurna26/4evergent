import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const stacks = [
  ['@4evergent/api', 'API'],
  ['@4evergent/cli', 'CLI'],
  ['@4evergent/database', 'Database'],
  ['@4evergent/policy', 'Policy'],
  ['@4evergent/stellar', 'Stellar'],
  ['@4evergent/agent-core', 'Agent core'],
  ['@4evergent/shared', 'Shared'],
  ['@4evergent/web', 'Web'],
];

const results = [];
let failed = false;

for (const [filter, label] of stacks) {
  console.log(`\n===== ${label} coverage (${filter}) =====`);
  const result = spawnSync(pnpm, ['--filter', filter, 'test:coverage'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (output) process.stdout.write(output);

  const summaryLine = output
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:ℹ\s*)?all files\s*\|/i.test(line))
    .at(-1);
  results.push({ label, summaryLine: summaryLine?.trim() ?? 'Coverage summary unavailable' });

  if (!summaryLine) {
    console.error(`${label} coverage did not produce an aggregate summary row`);
    failed = true;
  }

  if (result.error) {
    console.error(`${label} coverage could not start: ${result.error.message}`);
    failed = true;
  } else if (result.status !== 0) {
    console.error(`${label} coverage exited with status ${result.status ?? 'unknown'}`);
    failed = true;
  }
}

console.log('\n===== Combined coverage summary =====');
for (const { label, summaryLine } of results) {
  console.log(`${label}: ${summaryLine}`);
}

if (failed) process.exitCode = 1;
