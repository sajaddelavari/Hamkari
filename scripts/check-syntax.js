import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const selectedRoots = ['server.js', 'src', 'public', 'scripts', 'test', 'playwright.config.js'];
const ignoredDirectories = new Set([
  'node_modules',
  'playwright-report',
  'test-results',
  'coverage',
]);

function javascriptFiles(path) {
  const info = statSync(path);
  if (info.isFile()) return path.endsWith('.js') ? [path] : [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => !ignoredDirectories.has(entry.name))
    .flatMap((entry) => javascriptFiles(resolve(path, entry.name)));
}

const files = selectedRoots
  .flatMap((entry) => javascriptFiles(resolve(root, entry)))
  .sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

process.stdout.write(`Syntax check passed for ${files.length} JavaScript files.\n`);
