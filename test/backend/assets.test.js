import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

test('initial public assets stay within the compressed budget and avoid unsafe DOM sinks', () => {
  const assetPaths = [
    'public/styles.css',
    'public/app.js',
    'public/assets/fonts/vazirmatn.woff2',
  ];
  const compressedBytes = assetPaths.reduce(
    (total, path) => total + gzipSync(readFileSync(resolve(root, path))).length,
    0,
  );
  assert.ok(
    compressedBytes <= 150_000,
    `initial CSS/JS/font gzip budget exceeded: ${compressedBytes} bytes`,
  );

  const app = readFileSync(resolve(root, 'public/app.js'), 'utf8');
  const admin = readFileSync(resolve(root, 'public/admin.js'), 'utf8');
  const index = readFileSync(resolve(root, 'public/index.html'), 'utf8');
  const styles = readFileSync(resolve(root, 'public/styles.css'), 'utf8');
  assert.equal(/\binnerHTML\b/.test(`${app}\n${admin}`), false);
  assert.equal(/<(?:script|link)[^>]+https?:\/\//i.test(index), false);
  assert.match(
    index,
    /<link\s+rel="preload"\s+href="\/assets\/fonts\/vazirmatn\.woff2"\s+as="font"\s+type="font\/woff2"\s+crossorigin>/,
  );
  assert.match(styles, /font-display:\s*swap/);
});
