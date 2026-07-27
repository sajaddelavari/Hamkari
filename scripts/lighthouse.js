import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import * as chromeLauncher from 'chrome-launcher';
import { createApplication } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const port = Number(process.env.LIGHTHOUSE_PORT || 43_219);
const origin = `http://127.0.0.1:${port}`;
const targetUrl = `${origin}/projects/greenhouse-20ha`;
const runCount = Number(process.env.LIGHTHOUSE_RUNS || 3);
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

class IncompleteLighthouseSampleError extends Error {}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function numericAudit(lhr, auditId) {
  const audit = lhr.audits[auditId];
  if (Number.isFinite(audit?.numericValue)) return audit.numericValue;
  const reason = audit?.errorMessage || audit?.scoreDisplayMode || 'audit missing';
  throw new IncompleteLighthouseSampleError(
    `Lighthouse audit "${auditId}" did not produce a numeric value (${reason}).`,
  );
}

function layoutShiftDiagnostics(lhr) {
  const items = lhr.audits['layout-shifts']?.details?.items;
  if (!Array.isArray(items)) return [];
  return items.slice(0, 5).map(item => ({
    score: item.score,
    node: item.node?.selector || item.node?.snippet || item.node?.nodeLabel || null,
    causes: item.subItems?.items?.map(cause => ({
      cause: cause.cause,
      value: cause.extra?.value || cause.extra?.selector || null,
    })) || [],
  }));
}

function summarize(lhr) {
  const categoryScore = (categoryId) => {
    const score = lhr.categories[categoryId]?.score;
    if (Number.isFinite(score)) return Math.round(score * 100);
    throw new IncompleteLighthouseSampleError(
      `Lighthouse category "${categoryId}" did not produce a score.`,
    );
  };
  return {
    performance: categoryScore('performance'),
    accessibility: categoryScore('accessibility'),
    bestPractices: categoryScore('best-practices'),
    seo: categoryScore('seo'),
    cls: Number(numericAudit(lhr, 'cumulative-layout-shift').toFixed(4)),
    lcpMs: Math.round(numericAudit(lhr, 'largest-contentful-paint')),
    transferredBytes: Math.round(numericAudit(lhr, 'total-byte-weight')),
  };
}

function aggregate(samples) {
  return {
    profile: 'lighthouse-desktop-dense-4g',
    runs: samples.length,
    performance: median(samples.map(sample => sample.performance)),
    accessibility: Math.min(...samples.map(sample => sample.accessibility)),
    bestPractices: Math.min(...samples.map(sample => sample.bestPractices)),
    seo: Math.min(...samples.map(sample => sample.seo)),
    // Layout instability is never hidden by aggregation.
    cls: Math.max(...samples.map(sample => sample.cls)),
    lcpMs: median(samples.map(sample => sample.lcpMs)),
    transferredBytes: Math.max(...samples.map(sample => sample.transferredBytes)),
    samples,
  };
}

async function warmApplicationServer() {
  // Warm only server-side routing, SQLite statements and static-file reads.
  // Lighthouse still runs with a clean browser cache on every sample.
  for (const path of ['/healthz', '/api/v1/projects/greenhouse-20ha', '/styles.css']) {
    const response = await fetch(`${origin}${path}`, {
      headers: { 'user-agent': 'hamsakht-lighthouse-server-warmup' },
    });
    if (!response.ok) {
      throw new Error(`Lighthouse warm-up failed for ${path}: HTTP ${response.status}`);
    }
    await response.arrayBuffer();
  }
}

try {
  if (!Number.isInteger(runCount) || runCount < 1 || runCount > 5 || runCount % 2 === 0) {
    throw new Error('LIGHTHOUSE_RUNS must be an odd integer from 1 to 5.');
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await warmApplicationServer();
  chrome = await chromeLauncher.launch({
    chromePath: process.env.CHROME_PATH || undefined,
    chromeFlags: [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
    ],
    userDataDir: chromeProfile,
  });
  const samples = [];
  const maximumAttempts = runCount + 2;
  for (let attempt = 1; samples.length < runCount && attempt <= maximumAttempts; attempt += 1) {
    const result = await lighthouse(
      targetUrl,
      {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      },
      desktopConfig,
    );
    try {
      const sample = summarize(result.lhr);
      if (sample.cls >= 0.1) {
        console.warn(
          `High-CLS sample diagnostics: ${JSON.stringify(layoutShiftDiagnostics(result.lhr))}`,
        );
      }
      samples.push(sample);
    } catch (error) {
      if (!(error instanceof IncompleteLighthouseSampleError)) throw error;
      console.warn(
        `${error.message} Discarding attempt ${attempt}/${maximumAttempts}.`,
      );
    }
  }
  if (samples.length !== runCount) {
    throw new Error(
      `Lighthouse produced ${samples.length}/${runCount} complete samples ` +
      `after ${maximumAttempts} attempts.`,
    );
  }
  const summary = aggregate(samples);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (
    summary.performance < 95 ||
    summary.accessibility < 95 ||
    summary.bestPractices < 95 ||
    summary.seo < 95 ||
    summary.lcpMs >= 2_500 ||
    summary.cls >= 0.1
  ) {
    throw new Error(
      `Lighthouse budget failed: performance=${summary.performance}, ` +
      `accessibility=${summary.accessibility}, bestPractices=${summary.bestPractices}, ` +
      `seo=${summary.seo}, LCP=${summary.lcpMs}ms, CLS=${summary.cls}`,
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
