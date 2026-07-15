import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

function loadPlaywright() {
  const localRequire = createRequire(import.meta.url);
  try {
    return localRequire('playwright');
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter);
  for (const entry of pathEntries) {
    const normalized = entry.replace(/[\\/]+$/, '');
    const binName = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
    const binPath = path.join(normalized, binName);
    const packagePath = path.resolve(normalized, '..', 'playwright', 'package.json');
    if (fs.existsSync(binPath) && fs.existsSync(packagePath)) {
      return createRequire(packagePath)('playwright');
    }
  }

  throw new Error('Cannot load Playwright. Run `npm install` from the cloudflare directory first.');
}

const { chromium } = loadPlaywright();
const targetUrl = process.argv[2] || 'https://flux-image-gen.irisx-tracker.workers.dev';
const outputPath = path.resolve(process.argv[3] || 'output/playwright/cloudflare-perf-qa.json');
const budgets = {
  ttfbMs: 800,
  fcpMs: 1800,
  lcpMs: 2500,
  cls: 0.1,
  totalTransferKb: 900,
  scriptTransferKb: 150,
  stylesheetTransferKb: 180,
  resourceCount: 40,
};

function round(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function kb(bytes) {
  return round(Number(bytes || 0) / 1024);
}

function rateMetric(value, good, needsImprovement) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'missing';
  if (value <= good) return 'good';
  if (value <= needsImprovement) return 'needs-improvement';
  return 'poor';
}

function budgetCheck(name, value, max) {
  return { name, value, max, pass: value <= max };
}

async function main() {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const responseRecords = [];
  const responseTasks = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    const task = (async () => {
      const request = response.request();
      const headers = response.headers();
      let bodyBytes = 0;
      try {
        await response.finished();
        bodyBytes = (await response.body()).length;
      } catch (error) {
        bodyBytes = Number(headers['content-length'] || 0) || 0;
      }
      responseRecords.push({
        url: response.url(),
        status: response.status(),
        resourceType: request.resourceType(),
        bodyBytes,
        cacheControl: headers['cache-control'] || '',
        contentType: headers['content-type'] || '',
      });
    })();
    responseTasks.push(task);
  });

  await page.addInitScript(() => {
    window.__perfQA = { lcp: 0, cls: 0, lcpElement: '', layoutShiftSources: [] };
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) {
          window.__perfQA.lcp = last.startTime;
          window.__perfQA.lcpElement = last.element ? last.element.tagName : '';
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (error) {}
    try {
      new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          if (!entry.hadRecentInput) {
            window.__perfQA.cls += entry.value;
            if (entry.sources && entry.sources.length) {
              window.__perfQA.layoutShiftSources.push(entry.sources.map((source) => {
                return source.node ? source.node.tagName : 'unknown';
              }).join(','));
            }
          }
        });
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (error) {}
  });

  const startedAt = new Date().toISOString();
  // Turnstile and other third-party widgets may keep background requests open,
  // so networkidle is not a reliable production-ready signal for this page.
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);
  await Promise.allSettled(responseTasks);

  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paints = performance.getEntriesByType('paint').reduce((acc, entry) => {
      acc[entry.name] = entry.startTime;
      return acc;
    }, {});
    const resources = performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      transferSize: entry.transferSize || 0,
      encodedBodySize: entry.encodedBodySize || 0,
      duration: entry.duration || 0,
    }));
    return {
      nav: nav ? nav.toJSON() : null,
      paints,
      resources,
      observed: window.__perfQA || {},
    };
  });

  await browser.close();

  const nav = metrics.nav || {};
  const resources = metrics.resources || [];
  const resourcesByUrl = new Map(resources.map((entry) => [entry.name, entry]));
  const measuredResponses = responseRecords.filter((entry) => entry.status >= 200 && entry.status < 400);
  const targetOrigin = new URL(targetUrl).origin;
  const isFirstParty = (entry) => {
    try {
      return new URL(entry.url).origin === targetOrigin;
    } catch (error) {
      return false;
    }
  };
  const firstPartyResponses = measuredResponses.filter(isFirstParty);
  const thirdPartyResponses = measuredResponses.filter((entry) => !isFirstParty(entry));
  const scripts = measuredResponses.filter((entry) => entry.resourceType === 'script');
  const firstPartyScripts = scripts.filter(isFirstParty);
  const thirdPartyScripts = scripts.filter((entry) => !firstPartyScripts.includes(entry));
  const stylesheets = measuredResponses.filter((entry) => entry.resourceType === 'stylesheet' || /\.css(?:\?|$)/.test(entry.url));
  const allTransfer = measuredResponses.reduce((sum, entry) => sum + Number(entry.bodyBytes || 0), 0);
  const totalTransfer = firstPartyResponses.reduce((sum, entry) => sum + Number(entry.bodyBytes || 0), 0);
  const thirdPartyTransfer = thirdPartyResponses.reduce((sum, entry) => sum + Number(entry.bodyBytes || 0), 0);
  const scriptTransfer = firstPartyScripts.reduce((sum, entry) => sum + Number(entry.bodyBytes || 0), 0);
  const thirdPartyScriptTransfer = thirdPartyScripts.reduce((sum, entry) => sum + Number(entry.bodyBytes || 0), 0);
  const stylesheetTransfer = stylesheets.reduce((sum, entry) => sum + Number(entry.bodyBytes || 0), 0);

  const summary = {
    url: targetUrl,
    startedAt,
    metrics: {
      ttfbMs: round((nav.responseStart || 0) - (nav.requestStart || nav.startTime || 0)),
      fcpMs: round(metrics.paints['first-contentful-paint']),
      lcpMs: round(metrics.observed.lcp),
      cls: round(metrics.observed.cls),
      domContentLoadedMs: round((nav.domContentLoadedEventEnd || 0) - (nav.startTime || 0)),
      loadEventMs: round((nav.loadEventEnd || 0) - (nav.startTime || 0)),
      resourceCount: measuredResponses.length,
      totalTransferKb: kb(totalTransfer),
      thirdPartyTransferKb: kb(thirdPartyTransfer),
      allTransferKb: kb(allTransfer),
      scriptTransferKb: kb(scriptTransfer),
      thirdPartyScriptTransferKb: kb(thirdPartyScriptTransfer),
      stylesheetTransferKb: kb(stylesheetTransfer),
    },
    ratings: {},
    budgets: [],
    topResources: measuredResponses
      .slice()
      .sort((left, right) => Number(right.bodyBytes || 0) - Number(left.bodyBytes || 0))
      .slice(0, 10)
      .map((entry) => {
        const timing = resourcesByUrl.get(entry.url) || {};
        return {
          url: entry.url,
          type: entry.resourceType,
          transferKb: kb(entry.bodyBytes),
          durationMs: round(timing.duration),
          cacheControl: entry.cacheControl,
        };
      }),
    consoleErrors,
    pageErrors,
  };

  summary.ratings = {
    ttfb: rateMetric(summary.metrics.ttfbMs, 800, 1800),
    fcp: rateMetric(summary.metrics.fcpMs, 1800, 3000),
    lcp: rateMetric(summary.metrics.lcpMs, 2500, 4000),
    cls: rateMetric(summary.metrics.cls, 0.1, 0.25),
  };
  summary.budgets = [
    budgetCheck('TTFB', summary.metrics.ttfbMs, budgets.ttfbMs),
    budgetCheck('FCP', summary.metrics.fcpMs, budgets.fcpMs),
    budgetCheck('LCP', summary.metrics.lcpMs, budgets.lcpMs),
    budgetCheck('CLS', summary.metrics.cls, budgets.cls),
    budgetCheck('first-party total transfer KB', summary.metrics.totalTransferKb, budgets.totalTransferKb),
    budgetCheck('first-party script transfer KB', summary.metrics.scriptTransferKb, budgets.scriptTransferKb),
    budgetCheck('stylesheet transfer KB', summary.metrics.stylesheetTransferKb, budgets.stylesheetTransferKb),
    budgetCheck('resource count', summary.metrics.resourceCount, budgets.resourceCount),
  ];

  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(summary, null, 2));

  const failed = summary.budgets.filter((item) => !item.pass);
  if (consoleErrors.length || pageErrors.length || failed.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
