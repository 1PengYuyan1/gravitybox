import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyVerifiedPriceUpdate,
  buildAutoStagedAliases,
  bumpCatalogVersion,
  detectBlockedOrEmptyPage,
  evaluateModelConsensus,
  evaluateNewModelStagingCandidate,
  extractCleanPricingText,
  extractPricesWithGemini,
  normalizeUpstreamModelKey,
  parseLiteLlmRates,
  parseOpenRouterRates,
  runAutoUpdatePricing,
} from '../tools/auto-update-pricing.mjs';
import { buildPricingFeed } from '../tools/sync-pricing-feed.mjs';
import * as pricingMod from '../dist/pricing.js';

const { resolvePricingForTimestamp } = pricingMod;

test('HTML 降噪：剥离噪声标签、保留表格结构并在超长页面优先保留底部价格锚点', () => {
  const filler = '<p>无关营销文案介绍段落。'.repeat(120) + '</p>';
  const html = `
    <html>
      <head><style>.x{color:red}</style><script>window.__data={};</script></head>
      <body>
        <nav><a href="/home">Home</a></nav>
        ${filler}
        <table>
          <tr><th>Model</th><th>Input</th><th>Output</th></tr>
          <tr><td>Claude Sonnet 5.5</td><td>$2.00 / 1M tokens</td><td>$10.00 / 1M tokens</td></tr>
        </table>
        <footer>Copyright 2026</footer>
      </body>
    </html>
  `;
  const clean = extractCleanPricingText(html, 900);
  assert.equal(clean.includes('window.__data'), false);
  assert.equal(clean.includes('Copyright 2026'), false);
  assert.match(clean, /Claude Sonnet 5\.5 \| \$2\.00 \/ 1M tokens \| \$10\.00 \/ 1M tokens/);

  assert.equal(
    detectBlockedOrEmptyPage('<html>Just a moment... cf-browser-verification</html>', 'Just a moment', null),
    'anti_bot_challenge'
  );
  assert.equal(detectBlockedOrEmptyPage('<html><body></body></html>', 'tiny', null), 'empty_or_csr_shell');
});

test('LiteLLM 与 OpenRouter 解析：过滤区域/batch/非文本通道，保留直连标准报价', () => {
  const parsedLt = parseLiteLlmRates({
    'bedrock/anthropic.claude-sonnet-5-5-v1': { input_cost_per_token: 9e-6, output_cost_per_token: 9e-5 },
    'openai/gpt-4o-batch': { input_cost_per_token: 1.25e-6, output_cost_per_token: 5e-6 },
    'vertex_ai/us-central1/gemini-3.8-flash': { input_cost_per_token: 9e-6, output_cost_per_token: 9e-5 },
    'anthropic/claude-sonnet-5-5': {
      input_cost_per_token: 2e-6,
      output_cost_per_token: 10e-6,
      cache_read_input_token_cost: 0.1e-6,
      cache_creation_input_token_cost: 2.5e-6,
    },
    'vertex_ai/gemini-3.8-flash': { input_cost_per_token: 0.9e-6, output_cost_per_token: 4.5e-6 },
    'gemini/gemini-3.8-flash': {
      input_cost_per_token: 0.75e-6,
      output_cost_per_token: 3.75e-6,
      cache_read_input_token_cost: 0.075e-6,
    },
  });

  assert.equal(parsedLt.get('claude-sonnet-5-5')?.input, 2);
  assert.equal(parsedLt.get('claude-sonnet-5-5')?.cacheWrite, 2.5);
  assert.equal(parsedLt.get('gemini-3.8-flash')?.input, 0.75);
  assert.equal(parsedLt.has('gpt-4o-batch'), false);

  const parsedOr = parseOpenRouterRates({
    data: [
      { id: 'anthropic/claude-sonnet-5-5', pricing: { prompt: '0.000002', completion: '0.00001' } },
      { id: 'openai/gpt-4o:free', pricing: { prompt: '0', completion: '0' } },
    ],
  });
  assert.equal(parsedOr.get('claude-sonnet-5-5')?.output, 10);
  assert.equal(parsedOr.has('gpt-4o:free'), false);
});

test('共识门禁：双源一致放行 green，分歧/孤证/越界波动/未来预设区间拦截为 yellow', () => {
  const nowMs = Date.parse('2026-11-17T02:00:00Z');
  const baseEntry = {
    model: 'claude-sonnet-5-5',
    input: 3.0,
    output: 15.0,
    cached: 0.3,
    cacheWrite: 3.75,
    provenance: { verification: 'confirmed', sourceUrl: 'https://www.anthropic.com/pricing' },
  };

  const green = evaluateModelConsensus({
    key: 'claude-sonnet-5-5',
    localEntry: baseEntry,
    official: {
      officialModelName: 'Claude Sonnet 5.5',
      inputPer1M: 2.0,
      outputPer1M: 10.0,
      cachedPer1M: 0.2,
      cacheWritePer1M: 2.5,
      hasContextTiers: false,
      confidence: 'high',
      evidenceQuote: 'Claude Sonnet 5.5: $2 / MTok input, $10 / MTok output',
    },
    litellm: { input: 2.0, output: 10.0, cached: 0.2, cacheWrite: 2.5 },
    nowMs,
  });
  assert.equal(green.status, 'green');
  assert.deepEqual(green.proposed, { input: 2, output: 10, cached: 0.2, cacheWrite: 2.5 });

  const diverged = evaluateModelConsensus({
    key: 'claude-sonnet-5-5',
    localEntry: baseEntry,
    official: { officialModelName: 'Claude Sonnet 5.5', inputPer1M: 2.0, outputPer1M: 10.0, cachedPer1M: 0.2, cacheWritePer1M: 2.5, confidence: 'high', evidenceQuote: '...' },
    litellm: { input: 2.5, output: 12.0, cached: 0.25, cacheWrite: 3.0 },
    nowMs,
  });
  assert.equal(diverged.status, 'yellow');

  const singleSource = evaluateModelConsensus({
    key: 'claude-sonnet-5-5',
    localEntry: baseEntry,
    official: { officialModelName: 'Claude Sonnet 5.5', inputPer1M: 2.0, outputPer1M: 10.0, cachedPer1M: 0.2, cacheWritePer1M: 2.5, confidence: 'high', evidenceQuote: '...' },
    litellm: null,
    nowMs,
  });
  assert.equal(singleSource.status, 'yellow');

  const extremeDrop = evaluateModelConsensus({
    key: 'claude-sonnet-5-5',
    localEntry: baseEntry,
    official: { officialModelName: 'Claude Sonnet 5.5', inputPer1M: 0.3, outputPer1M: 1.5, cachedPer1M: 0.03, cacheWritePer1M: 0.375, confidence: 'high', evidenceQuote: '...' },
    litellm: { input: 0.3, output: 1.5, cached: 0.03, cacheWrite: 0.375 },
    nowMs,
  });
  assert.equal(extremeDrop.status, 'yellow');

  const withFutureInterval = {
    ...baseEntry,
    intervals: [
      { model: 'claude-sonnet-5-5', validFrom: null, validUntil: '2026-11-30T23:59:59Z', input: 3, output: 15, cached: 0.3, cacheWrite: 3.75 },
      { model: 'claude-sonnet-5-5', validFrom: '2026-12-01T00:00:00Z', validUntil: null, input: 4, output: 20, cached: 0.4, cacheWrite: 5.0 },
    ],
  };
  const futureBlocked = evaluateModelConsensus({
    key: 'claude-sonnet-5-5',
    localEntry: withFutureInterval,
    official: { officialModelName: 'Claude Sonnet 5.5', inputPer1M: 2.0, outputPer1M: 10.0, cachedPer1M: 0.2, cacheWritePer1M: 2.5, confidence: 'high', evidenceQuote: '...' },
    litellm: { input: 2.0, output: 10.0, cached: 0.2, cacheWrite: 2.5 },
    nowMs,
  });
  assert.equal(futureBlocked.status, 'yellow');

  // 若官网价正好吻合本地已排期的未来生效区间（如 gemini-4-hydrogen 的 2027-01-12 cacheWrite=$1.875），不重复报黄灯
  const hydrogenScheduledEntry = {
    model: 'gemini-4-hydrogen',
    input: 1.5,
    output: 7.5,
    cached: 0.075,
    cacheWrite: 0,
    intervals: [
      { model: 'gemini-4-hydrogen', validFrom: null, validUntil: '2027-01-11T23:59:59Z', input: 1.5, output: 7.5, cached: 0.075, cacheWrite: 0 },
      { model: 'gemini-4-hydrogen', validFrom: '2027-01-12T00:00:00Z', validUntil: null, input: 1.5, output: 7.5, cached: 0.075, cacheWrite: 1.875 },
    ],
  };
  const scheduledExpected = evaluateModelConsensus({
    key: 'gemini-4-hydrogen',
    localEntry: hydrogenScheduledEntry,
    official: { officialModelName: 'Gemini 4 Hydrogen', inputPer1M: 1.5, outputPer1M: 7.5, cachedPer1M: 0.075, cacheWritePer1M: 1.875, confidence: 'high', evidenceQuote: '...' },
    litellm: { input: 1.5, output: 7.5, cached: 0.075 },
    nowMs,
  });
  assert.equal(scheduledExpected.status, 'unchanged');

  // gemini-4-neon 同样按 2027-01-12 cacheWrite=$3.75 未来区间排期，不应误报黄灯
  const neonScheduledEntry = {
    model: 'gemini-4-neon',
    input: 3.0,
    output: 15.0,
    cached: 0.15,
    cacheWrite: 0,
    intervals: [
      { model: 'gemini-4-neon', validFrom: null, validUntil: '2027-01-11T23:59:59Z', input: 3.0, output: 15.0, cached: 0.15, cacheWrite: 0 },
      { model: 'gemini-4-neon', validFrom: '2027-01-12T00:00:00Z', validUntil: null, input: 3.0, output: 15.0, cached: 0.15, cacheWrite: 3.75 },
    ],
  };
  const neonScheduledExpected = evaluateModelConsensus({
    key: 'gemini-4-neon',
    localEntry: neonScheduledEntry,
    official: { officialModelName: 'Gemini 4 Neon', inputPer1M: 3.0, outputPer1M: 15.0, cachedPer1M: 0.15, cacheWritePer1M: 3.75, confidence: 'high', evidenceQuote: '...' },
    litellm: { input: 3.0, output: 15.0, cached: 0.15 },
    nowMs: Date.parse('2026-11-19T02:00:00Z'),
  });
  assert.equal(neonScheduledExpected.status, 'unchanged');
});

test('安全增量写入：不篡改历史区间、保持英文 provenance 无中文残留并正确递增 -rN 版本号', () => {
  assert.equal(bumpCatalogVersion('2026-11-13', '2026-11-17'), '2026-11-17');
  assert.equal(bumpCatalogVersion('2026-11-17', '2026-11-17'), '2026-11-17-r2');
  assert.equal(bumpCatalogVersion('2026-11-17-r2', '2026-11-17'), '2026-11-17-r3');

  const catalog = {
    pricingVersion: '2026-11-13',
    pricingUpdatedAt: '2026-11-13T00:00:00Z',
    prices: {
      'claude-3-5-haiku': {
        model: 'claude-3-5-haiku',
        input: 1.0,
        output: 5.0,
        cached: 0.1,
        cacheWrite: 1.25,
        provenance: {
          sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
          platform: 'Anthropic 标准 API',
          conditions: 'Anthropic 官方 Claude 3.5 Haiku 标准文本基准',
          checkedAt: '2026-11-12',
          validFrom: null,
          validUntil: null,
          verification: 'confirmed',
        },
      },
    },
  };

  const day1Ms = Date.parse('2026-11-17T02:00:00Z');
  applyVerifiedPriceUpdate(catalog, 'claude-3-5-haiku', { input: 0.8, output: 4.0, cached: 0.08, cacheWrite: 1.0 }, day1Ms);

  const entry = catalog.prices['claude-3-5-haiku'];
  assert.equal(entry.input, 0.8);
  assert.equal(entry.intervals.length, 2);
  assert.equal(entry.intervals[0].validUntil, '2026-11-16T23:59:59Z');
  assert.equal(entry.intervals[1].validFrom, '2026-11-17T00:00:00Z');
  assert.equal(catalog.pricingVersion, '2026-11-17');

  const oldPrice = resolvePricingForTimestamp(entry, Math.floor(Date.parse('2026-11-16T12:00:00Z') / 1000));
  const newPrice = resolvePricingForTimestamp(entry, Math.floor(Date.parse('2026-11-17T12:00:00Z') / 1000));
  assert.equal(oldPrice?.input, 1.0);
  assert.equal(newPrice?.input, 0.8);

  assert.equal(/[\u4e00-\u9fff]/.test(entry.provenance.conditionsEn ?? ''), false);
  if (typeof pricingMod.localizePricingProvenance === 'function') {
    const enProv = pricingMod.localizePricingProvenance(entry.provenance, 'en');
    assert.equal(/[\u4e00-\u9fff]/.test(enProv?.conditions ?? ''), false);
  }

  // 同日二次更新只刷新当日区间且版本号递增为 -r2
  const day1SecondMs = Date.parse('2026-11-17T08:00:00Z');
  applyVerifiedPriceUpdate(catalog, 'claude-3-5-haiku', { input: 0.75, output: 3.75, cached: 0.075, cacheWrite: 0.94 }, day1SecondMs);
  assert.equal(entry.intervals.length, 2);
  assert.equal(entry.intervals[1].input, 0.75);
  assert.equal(catalog.pricingVersion, '2026-11-17-r2');
});

test('端到端干跑与自动写入：模拟官网 + Gemini Flash + LiteLLM 全绿闭环并生成一致 pricing-feed.json', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-auto-pricing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');

  const fixtureCatalog = {
    schema: 1,
    names: { 'claude-3-5-haiku': 'Claude 3.5 Haiku' },
    prices: {
      'claude-3-5-haiku': {
        model: 'claude-3-5-haiku',
        input: 1.0,
        output: 5.0,
        cached: 0.1,
        cacheWrite: 1.25,
        provenance: {
          sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
          platform: 'Anthropic 标准 API',
          conditions: 'Anthropic 官方标准文本基准',
          checkedAt: '2026-11-12',
          validFrom: null,
          validUntil: null,
          verification: 'confirmed',
        },
      },
    },
    activeModels: ['claude-3-5-haiku'],
    feedModels: ['claude-3-5-haiku'],
    pricingVersion: '2026-11-13',
    pricingUpdatedAt: '2026-11-13T00:00:00Z',
  };
  await writeFile(catalogPath, JSON.stringify(fixtureCatalog, null, 2) + '\n', 'utf8');

  const mockFetch = async (url) => {
    const target = String(url);
    if (target.includes('platform.claude.com')) {
      return new Response(
        '<html><body><h1>Anthropic Claude Pricing</h1>' +
          '<p>Standard API pricing per million tokens (MTok) for Claude models:</p>' +
          '<table><tr><td>Claude 3.5 Haiku</td><td>$0.80 / MTok</td><td>$4.00 / MTok</td><td>$0.08 / MTok</td><td>$1.00 / MTok</td></tr></table>' +
          '<p>All prices are in USD per 1M input and output tokens for standard global API endpoints.</p></body></html>',
        { status: 200 }
      );
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      pageParsedOk: true,
                      models: [
                        {
                          catalogKey: 'claude-3-5-haiku',
                          officialModelName: 'Claude 3.5 Haiku',
                          inputPer1M: 0.8,
                          outputPer1M: 4.0,
                          cachedPer1M: 0.08,
                          cacheWritePer1M: 1.0,
                          hasContextTiers: false,
                          confidence: 'high',
                          evidenceQuote: 'Claude 3.5 Haiku | $0.80 / MTok | $4.00 / MTok',
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (target.includes('litellm')) {
      return new Response(
        JSON.stringify({
          'anthropic/claude-3-5-haiku': {
            input_cost_per_token: 0.8e-6,
            output_cost_per_token: 4.0e-6,
            cache_read_input_token_cost: 0.08e-6,
            cache_creation_input_token_cost: 1.0e-6,
          },
        }),
        { status: 200 }
      );
    }
    if (target.includes('openrouter.ai')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    throw new Error(`Unexpected URL in mockFetch: ${target}`);
  };

  const report = await runAutoUpdatePricing({
    write: true,
    nowMs: Date.parse('2026-11-17T02:00:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: mockFetch,
  });

  assert.equal(report.decision, 'green_auto_merge');
  assert.equal(report.filesModified, true);
  assert.equal(report.greenUpdates.length, 1);

  const updatedCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const updatedFeed = JSON.parse(await readFile(feedPath, 'utf8'));
  assert.equal(updatedCatalog.pricingVersion, '2026-11-17');
  assert.deepEqual(buildPricingFeed(updatedCatalog), updatedFeed);
  assert.equal(updatedFeed.prices['claude-3-5-haiku'][1].input, 0.8);
});

test('上游抓取异常与确定性 4xx 防护：HTTP 404 不重试，上游阻塞时返回 fetch_failed 防误关告警 Issue', async (t) => {
  let geminiCalls = 0;
  await assert.rejects(
    () =>
      extractPricesWithGemini({
        url: 'https://cloud.google.com/vertex-ai/pricing',
        vendor: 'Google',
        cleanText: 'Gemini 4 Hydrogen $1.50 / $7.50',
        targetModels: [{ key: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen' }],
        apiKey: 'fake-key',
        model: 'invalid-model-404',
        fetchImpl: async () => {
          geminiCalls++;
          return new Response('Not Found', { status: 404 });
        },
      }),
    /Gemini API HTTP 404/
  );
  assert.equal(geminiCalls, 1, '确定性 HTTP 404 应单次立即抛出，不浪费重试');

  const dir = await mkdtemp(join(tmpdir(), 'gb-auto-pricing-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');
  await writeFile(
    catalogPath,
    JSON.stringify({
      schema: 1,
      names: { 'claude-3-5-haiku': 'Claude 3.5 Haiku' },
      prices: {
        'claude-3-5-haiku': {
          model: 'claude-3-5-haiku',
          input: 1.0,
          output: 5.0,
          cached: 0.1,
          provenance: {
            sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
            verification: 'confirmed',
          },
        },
      },
      activeModels: ['claude-3-5-haiku'],
      feedModels: ['claude-3-5-haiku'],
      pricingVersion: '2026-11-17',
    }),
    'utf8'
  );

  const report = await runAutoUpdatePricing({
    write: false,
    nowMs: Date.parse('2026-11-17T02:00:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes('platform.claude.com')) return new Response('Forbidden', { status: 403 });
      if (target.includes('litellm')) return new Response('Service Unavailable', { status: 503 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });

  assert.equal(report.decision, 'fetch_failed');
  assert.equal(report.pageAlerts.length >= 2, true);
  assert.match(report.summaryMarkdown, /Upstream Fetch Alerts/);
});

test('normalizeUpstreamModelKey 规范化官网空格/星号/括号展示名并保留 :free 通道后缀', () => {
  assert.equal(normalizeUpstreamModelKey('Gemini 4 Neon'), 'gemini-4-neon');
  assert.equal(normalizeUpstreamModelKey('Gemini 4 Carbon*'), 'gemini-4-carbon');
  assert.equal(normalizeUpstreamModelKey('Gemini 4 Carbon (Starting December 1, 2026)'), 'gemini-4-carbon');
  assert.equal(normalizeUpstreamModelKey('Claude Opus 5.5'), 'claude-opus-5.5');
  assert.equal(normalizeUpstreamModelKey('gemini/gemini_4_neon@default'), 'gemini-4-neon');
  assert.equal(normalizeUpstreamModelKey('openai/gpt-4o:free'), 'gpt-4o:free');
});

test('新模型雷达回归：带空格与星号的官网新模型不再漏检，支持去重与三方查价关联，并排除已入库与 Cyber Permissive', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-auto-pricing-radar-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');

  const fixtureCatalog = {
    schema: 1,
    names: {
      'gemini-4-carbon': 'Gemini 4 Carbon',
      'claude-opus-5-5': 'Claude Opus 5.5',
    },
    prices: {
      'gemini-4-carbon': {
        model: 'gemini-4-carbon',
        input: 2.0,
        output: 10.0,
        cached: 0.1,
        provenance: {
          sourceUrl: 'https://cloud.google.com/model-garden/pricing?hl=en',
          platform: 'Google Cloud 标准 Global API',
          conditions: 'Google Cloud 官方推广期标准 Global API 文本基准（优惠截至2026-11-30）',
          checkedAt: '2026-11-19',
          validUntil: '2026-11-30T23:59:59Z',
          verification: 'confirmed',
        },
        intervals: [
          { model: 'gemini-4-carbon', validFrom: null, validUntil: '2026-11-30T23:59:59Z', input: 2.0, output: 10.0, cached: 0.1 },
          { model: 'gemini-4-carbon', validFrom: '2026-12-01T00:00:00Z', validUntil: null, input: 4.0, output: 20.0, cached: 0.2 },
        ],
      },
      'claude-opus-5-5': {
        model: 'claude-opus-5-5',
        input: 4.0,
        output: 20.0,
        cached: 0.2,
        cacheWrite: 5.0,
        provenance: {
          sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
          platform: 'Anthropic 标准 API',
          conditions: 'Anthropic 官方 Claude Opus 5.5 标准文本基准',
          checkedAt: '2026-11-19',
          validFrom: null,
          validUntil: null,
          verification: 'confirmed',
        },
      },
    },
    activeModels: ['gemini-4-carbon', 'claude-opus-5-5'],
    feedModels: ['gemini-4-carbon', 'claude-opus-5-5'],
    pricingVersion: '2026-11-19',
    pricingUpdatedAt: '2026-11-19T00:00:00Z',
  };
  await writeFile(catalogPath, JSON.stringify(fixtureCatalog, null, 2) + '\n', 'utf8');

  const mockFetch = async (url, init) => {
    const target = String(url);
    if (target.includes('cloud.google.com')) {
      return new Response(
        '<html><body><h1>Gemini Model Garden Standard Global API Pricing</h1>' +
          '<p>Standard pay-as-you-go text token pricing on Google Cloud per 1 million tokens in USD for global endpoints.</p>' +
          '<table><tr><td>Gemini 4 Carbon*</td><td>$2.00</td><td>$10.00</td></tr>' +
          '<tr><td>Gemini 4 Carbon Cyber Permissive</td><td>$4.00</td><td>$20.00</td></tr>' +
          '<tr><td>Gemini 5 Nova</td><td>$3.50</td><td>$17.50</td></tr></table>' +
          '<p>* Promotional pricing provided through 50% credits back through November 30, 2026 on eligible global endpoints.</p></body></html>',
        { status: 200 }
      );
    }
    if (target.includes('platform.claude.com')) {
      return new Response(
        '<html><body><h1>Anthropic Claude API Pricing (MTok)</h1>' +
          '<p>Standard API pricing per million tokens (MTok) in USD for Claude models on global endpoints.</p>' +
          '<table><tr><td>Claude Opus 5.5</td><td>$4.00 / MTok</td><td>$20.00 / MTok</td></tr>' +
          '<tr><td>Claude Sonnet 6.0</td><td>$2.50 / MTok</td><td>$12.50 / MTok</td></tr></table>' +
          '<p>All prices are in USD per 1M input, output, cache read, and cache write tokens for standard API endpoints.</p></body></html>',
        { status: 200 }
      );
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      const promptBody = String(init?.body ?? '');
      const isGooglePage = promptBody.includes('cloud.google.com');
      const bodyModels = isGooglePage
        ? [
            // 模拟 Gemini 提取时留空 catalogKey，验证通过归一化匹配已入库模型、去重与雷达过滤
            {
              catalogKey: '',
              officialModelName: 'Gemini 4 Carbon*',
              inputPer1M: 2.0,
              outputPer1M: 10.0,
              cachedPer1M: 0.1,
              hasContextTiers: false,
              confidence: 'high',
              evidenceQuote: 'Gemini 4 Carbon* | $2.00 | $10.00',
            },
            {
              catalogKey: '',
              officialModelName: 'Gemini 4 Carbon Cyber Permissive',
              inputPer1M: 4.0,
              outputPer1M: 20.0,
              cachedPer1M: 0.2,
              hasContextTiers: false,
              confidence: 'high',
              evidenceQuote: 'Gemini 4 Carbon Cyber Permissive | $4.00 | $20.00',
            },
            {
              catalogKey: '',
              officialModelName: 'Gemini 5 Nova',
              inputPer1M: 3.5,
              outputPer1M: 17.5,
              cachedPer1M: 0.175,
              hasContextTiers: false,
              confidence: 'high',
              evidenceQuote: 'Gemini 5 Nova | $3.50 | $17.50',
            },
            {
              catalogKey: '',
              officialModelName: 'Gemini 5 Nova*',
              inputPer1M: 7.0,
              outputPer1M: 35.0,
              cachedPer1M: 0.35,
              hasContextTiers: false,
              confidence: 'high',
              evidenceQuote: 'Gemini 5 Nova* promo row',
            },
          ]
        : [
            {
              catalogKey: '',
              officialModelName: 'Claude Opus 5.5',
              inputPer1M: 4.0,
              outputPer1M: 20.0,
              cachedPer1M: 0.2,
              cacheWritePer1M: 5.0,
              hasContextTiers: false,
              confidence: 'high',
              evidenceQuote: 'Claude Opus 5.5 | $4.00 | $20.00',
            },
            {
              catalogKey: '',
              officialModelName: 'Claude Sonnet 6.0',
              inputPer1M: 2.5,
              outputPer1M: 12.5,
              cachedPer1M: 0.25,
              cacheWritePer1M: 3.125,
              hasContextTiers: false,
              confidence: 'high',
              evidenceQuote: 'Claude Sonnet 6.0 | $2.50 | $12.50',
            },
          ];
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ pageParsedOk: true, models: bodyModels }) }],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (target.includes('litellm')) {
      return new Response(
        JSON.stringify({
          'gemini/gemini-4-carbon': { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: 0.1e-6 },
          'gemini/gemini-5-nova': { input_cost_per_token: 3.5e-6, output_cost_per_token: 17.5e-6, cache_read_input_token_cost: 0.175e-6 },
          'anthropic/claude-opus-5-5': { input_cost_per_token: 4e-6, output_cost_per_token: 20e-6, cache_read_input_token_cost: 0.2e-6, cache_creation_input_token_cost: 5e-6 },
          'anthropic/claude-sonnet-6-0': { input_cost_per_token: 2.5e-6, output_cost_per_token: 12.5e-6, cache_read_input_token_cost: 0.25e-6, cache_creation_input_token_cost: 3.125e-6 },
        }),
        { status: 200 }
      );
    }
    if (target.includes('openrouter.ai')) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'google/gemini-5-nova', pricing: { prompt: '0.0000035', completion: '0.0000175', input_cache_read: '0.000000175' } },
            { id: 'anthropic/claude-sonnet-6.0', pricing: { prompt: '0.0000025', completion: '0.0000125', input_cache_read: '0.00000025' } },
          ],
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL in mockFetch: ${target}`);
  };

  const report = await runAutoUpdatePricing({
    write: false,
    nowMs: Date.parse('2026-11-19T02:00:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: mockFetch,
  });

  assert.equal(report.decision, 'yellow_needs_review');
  assert.equal(report.yellowItems.length, 0);
  assert.deepEqual(
    report.newModelsRadar.map((n) => n.model),
    ['gemini-5-nova', 'claude-sonnet-6.0']
  );
  assert.equal(report.newModelsRadar[0].litellm?.input, 3.5);
  assert.equal(report.newModelsRadar[0].openrouter?.output, 17.5);
  assert.equal(report.newModelsRadar[1].litellm?.input, 2.5);
  assert.equal(report.newModelsRadar[1].openrouter?.output, 12.5);
});

test('新模型自动预入库门禁与 PR 草案生成：双源共识自动写 feedModels+衍生别名（不动 activeModels），未经 LiteLLM 确认的 cacheWrite 或阶梯价拦截', async (t) => {
  // 1) buildAutoStagedAliases：仅 Gemini 4+ 代号生成 Orchestrator / tiered 别名
  assert.deepEqual(buildAutoStagedAliases('gemini-5-nova'), {
    'gemini-pro-orchestrator-nova': 'gemini-5-nova',
    'orchestrator (nova)': 'gemini-5-nova',
    'Orchestrator (Nova)': 'gemini-5-nova',
    'gemini-5-nova-tiered': 'gemini-5-nova',
    'gemini-5-nova-tiered-low': 'gemini-5-nova',
    'gemini-5-nova-tiered-medium': 'gemini-5-nova',
    'gemini-5-nova-tiered-high': 'gemini-5-nova',
    'gemini-5-nova-tiered-xhigh': 'gemini-5-nova',
    'gemini-5-nova-tiered-extra-high': 'gemini-5-nova',
  });
  assert.deepEqual(buildAutoStagedAliases('claude-sonnet-6-0'), {});

  // 2) 未经 LiteLLM 确认的 cacheWritePer1M 或含 hasContextTiers 时不得自动预入库
  const blockedCacheWrite = evaluateNewModelStagingCandidate({
    id: 'gemini-5-pulsar',
    vendor: 'Google',
    url: 'https://cloud.google.com/model-garden/pricing?hl=en',
    official: {
      officialModelName: 'Gemini 5 Pulsar',
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      cachedPer1M: 0.15,
      cacheWritePer1M: 3.75,
      hasContextTiers: false,
      confidence: 'high',
    },
    litellm: { input: 3.0, output: 15.0, cached: 0.15 },
  });
  assert.equal(blockedCacheWrite.stageable, false);

  const blockedTiers = evaluateNewModelStagingCandidate({
    id: 'gemini-5-quasar',
    vendor: 'Google',
    url: 'https://cloud.google.com/model-garden/pricing?hl=en',
    official: {
      officialModelName: 'Gemini 5 Quasar',
      inputPer1M: 2.0,
      outputPer1M: 10.0,
      cachedPer1M: 0.1,
      hasContextTiers: true,
      confidence: 'high',
    },
    litellm: { input: 2.0, output: 10.0, cached: 0.1 },
  });
  assert.equal(blockedTiers.stageable, false);

  // 3) 端到端 write: true：严格双源共识新模型预写入 model-catalog.json 与 pricing-feed.json，决策保持 yellow_needs_review 走 PR 审阅
  const dir = await mkdtemp(join(tmpdir(), 'gb-auto-pricing-stage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');

  const fixtureCatalog = {
    schema: 1,
    names: { 'gemini-4-carbon': 'Gemini 4 Carbon' },
    prices: {
      'gemini-4-carbon': {
        model: 'gemini-4-carbon',
        input: 2.0,
        output: 10.0,
        cached: 0.1,
        provenance: {
          sourceUrl: 'https://cloud.google.com/model-garden/pricing?hl=en',
          platform: 'Google Cloud 标准 Global API',
          conditions: 'Google Cloud 官方推广期标准 Global API 文本基准（优惠截至2026-11-30）',
          checkedAt: '2026-11-18',
          validUntil: '2026-11-30T23:59:59Z',
          verification: 'confirmed',
        },
        intervals: [
          { model: 'gemini-4-carbon', validFrom: null, validUntil: '2026-11-30T23:59:59Z', input: 2.0, output: 10.0, cached: 0.1 },
          { model: 'gemini-4-carbon', validFrom: '2026-12-01T00:00:00Z', validUntil: null, input: 4.0, output: 20.0, cached: 0.2 },
        ],
      },
    },
    aliases: {},
    activeModels: ['gemini-4-carbon'],
    feedModels: ['gemini-4-carbon'],
    pricingVersion: '2026-11-18',
    pricingUpdatedAt: '2026-11-18T00:00:00Z',
  };
  await writeFile(catalogPath, JSON.stringify(fixtureCatalog, null, 2) + '\n', 'utf8');

  const mockFetch = async (url) => {
    const target = String(url);
    if (target.includes('cloud.google.com')) {
      return new Response(
        '<html><body><h1>Gemini Model Garden Standard Global API Pricing</h1>' +
          '<p>Standard pay-as-you-go text token pricing on Google Cloud per 1 million tokens in USD for global endpoints.</p>' +
          '<table><tr><td>Gemini 4 Carbon*</td><td>$2.00</td><td>$10.00</td></tr>' +
          '<tr><td>Gemini 5 Nova*</td><td>$3.50</td><td>$17.50</td></tr>' +
          '<tr><td>Gemini 5 Pulsar</td><td>$3.00</td><td>$15.00</td></tr></table>' +
          '<p>All rates apply to global standard pay-as-you-go text endpoints in USD.</p></body></html>',
        { status: 200 }
      );
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      pageParsedOk: true,
                      models: [
                        {
                          catalogKey: 'gemini-4-carbon',
                          officialModelName: 'Gemini 4 Carbon*',
                          inputPer1M: 2.0,
                          outputPer1M: 10.0,
                          cachedPer1M: 0.1,
                          hasContextTiers: false,
                          confidence: 'high',
                          evidenceQuote: 'Gemini 4 Carbon* | $2.00 | $10.00',
                        },
                        {
                          catalogKey: '',
                          officialModelName: 'Gemini 5 Nova*',
                          inputPer1M: 3.5,
                          outputPer1M: 17.5,
                          cachedPer1M: 0.175,
                          hasContextTiers: false,
                          confidence: 'high',
                          evidenceQuote: 'Gemini 5 Nova* | $3.50 | $17.50',
                        },
                        {
                          catalogKey: '',
                          officialModelName: 'Gemini 5 Pulsar',
                          inputPer1M: 3.0,
                          outputPer1M: 15.0,
                          cachedPer1M: 0.15,
                          cacheWritePer1M: 3.75,
                          hasContextTiers: false,
                          confidence: 'high',
                          evidenceQuote: 'Gemini 5 Pulsar | $3.00 | $15.00 | cw:$3.75',
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (target.includes('litellm')) {
      return new Response(
        JSON.stringify({
          'gemini/gemini-4-carbon': { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: 0.1e-6 },
          'gemini/gemini-5-nova': { input_cost_per_token: 3.5e-6, output_cost_per_token: 17.5e-6, cache_read_input_token_cost: 0.175e-6 },
          'gemini/gemini-5-pulsar': { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_read_input_token_cost: 0.15e-6 },
        }),
        { status: 200 }
      );
    }
    if (target.includes('openrouter.ai')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    throw new Error(`Unexpected URL in mockFetch: ${target}`);
  };

  const report = await runAutoUpdatePricing({
    write: true,
    nowMs: Date.parse('2026-11-19T02:00:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: mockFetch,
  });

  assert.equal(report.decision, 'yellow_needs_review', '新模型预入库必须走 yellow_needs_review 人工 PR 审阅');
  assert.equal(report.filesModified, true);
  assert.equal(report.stagedNewModels.length, 1);
  assert.equal(report.stagedNewModels[0].catalogKey, 'gemini-5-nova');
  assert.match(report.summaryMarkdown, /Auto-Staged New Model Candidates/);

  const updatedCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const updatedFeed = JSON.parse(await readFile(feedPath, 'utf8'));
  assert.equal(updatedCatalog.names['gemini-5-nova'], 'Gemini 5 Nova');
  assert.equal(updatedCatalog.prices['gemini-5-nova']?.input, 3.5);
  assert.equal(updatedCatalog.prices['gemini-5-nova']?.output, 17.5);
  assert.equal(updatedCatalog.prices['gemini-5-nova']?.cached, 0.175);
  assert.equal(updatedCatalog.prices['gemini-5-pulsar'], undefined, '未经 LiteLLM 确认 cacheWrite 的模型不得自动预写入');
  assert.equal(updatedCatalog.aliases['gemini-pro-orchestrator-nova'], 'gemini-5-nova');
  assert.equal(updatedCatalog.aliases['Orchestrator (Nova)'], 'gemini-5-nova');
  assert.deepEqual(updatedCatalog.activeModels, ['gemini-4-carbon'], 'activeModels 不得擅自扩大');
  assert.deepEqual(updatedCatalog.feedModels, ['gemini-4-carbon', 'gemini-5-nova']);
  assert.equal(updatedCatalog.pricingVersion, '2026-11-19');
  assert.deepEqual(buildPricingFeed(updatedCatalog), updatedFeed);

  if (typeof pricingMod.localizePricingProvenance === 'function') {
    const enProv = pricingMod.localizePricingProvenance(updatedCatalog.prices['gemini-5-nova'].provenance, 'en');
    assert.equal(/[\u4e00-\u9fff]/.test(enProv?.platform ?? ''), false);
    assert.equal(/[\u4e00-\u9fff]/.test(enProv?.conditions ?? ''), false);
  }
});

