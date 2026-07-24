import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const port = Number(process.env.LIGHTHOUSE_PORT || 43_219);
const origin = `http://127.0.0.1:${port}`;
const config = loadConfig({
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: String(port),
  PUBLIC_ORIGIN: origin,
  DATABASE_PATH: ':memory:',
  SESSION_SECRET: 'lighthouse-session-secret-longer-than-thirty-two-characters',
  ADMIN_DEV_PASSWORD: 'lighthouse-admin-password',
});
const application = createApplication({ config, logger: null });
const server = createServer(application.handler);
const chromeProfile = mkdtempSync(join(tmpdir(), 'hamkari-lighthouse-'));
let chrome;

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  chrome = await chromeLauncher.launch({
    chromePath: process.env.CHROME_PATH || undefined,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
    userDataDir: chromeProfile,
  });
  const result = await lighthouse(
    `${origin}/projects/greenhouse-20ha`,
    {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    },
  );
  const { lhr } = result;
  const summary = {
    performance: Math.round(lhr.categories.performance.score * 100),
    accessibility: Math.round(lhr.categories.accessibility.score * 100),
    bestPractices: Math.round(lhr.categories['best-practices'].score * 100),
    seo: Math.round(lhr.categories.seo.score * 100),
    cls: Number(lhr.audits['cumulative-layout-shift'].numericValue.toFixed(4)),
    lcpMs: Math.round(lhr.audits['largest-contentful-paint'].numericValue),
    transferredBytes: Math.round(lhr.audits['total-byte-weight'].numericValue),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (
    summary.performance < 95 ||
    summary.accessibility < 95 ||
    summary.cls >= 0.1
  ) {
    throw new Error(
      `Lighthouse budget failed: performance=${summary.performance}, ` +
      `accessibility=${summary.accessibility}, CLS=${summary.cls}`,
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (chrome) {
    try {
      chrome.kill();
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
    }
  }
  await new Promise((resolve) => server.close(resolve));
  application.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    rmSync(chromeProfile, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  } catch (error) {
    console.warn(`Chrome profile cleanup deferred: ${error.code || error.message}`);
  }
}
