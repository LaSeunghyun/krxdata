import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildGoogleNewsRssUrl,
  createJsonFileNewsCache,
  createNewsCache,
  fetchGoogleNewsRss,
  parseGoogleNewsRss,
  searchStockNews,
} from '../news-search.mjs';

const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel>
  <item>
    <title>삼성전자, 반도체 실적 개선 &amp; 주가 반등</title>
    <link>https://news.google.com/rss/articles/abc</link>
    <guid>abc</guid>
    <pubDate>Thu, 23 Jul 2026 01:00:00 GMT</pubDate>
    <source url="https://example.com">예시경제</source>
    <description>&lt;a href="https://example.com/a"&gt;삼성전자 뉴스&lt;/a&gt; 요약입니다.</description>
  </item>
  <item>
    <title>삼성전자 공급망 점검</title>
    <link>https://news.google.com/rss/articles/def</link>
    <pubDate>Thu, 23 Jul 2026 02:00:00 GMT</pubDate>
    <source url="https://example.net">시장일보</source>
    <description>두 번째 요약</description>
  </item>
</channel></rss>`;

test('parseGoogleNewsRss returns compact article fields only', () => {
  const rows = parseGoogleNewsRss(sampleRss, { limit: 1 });

  assert.deepEqual(rows, [{
    title: '삼성전자, 반도체 실적 개선 & 주가 반등',
    source: '예시경제',
    link: 'https://news.google.com/rss/articles/abc',
    published: '2026-07-23T01:00:00.000Z',
    snippet: '삼성전자 뉴스 요약입니다.',
  }]);
});

test('fetchGoogleNewsRss caches same query within ttl', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, text: async () => sampleRss };
  };
  const cache = createNewsCache();

  const first = await fetchGoogleNewsRss('삼성전자 005930', { fetchImpl, cache, now: () => 1_000, ttlMs: 60_000 });
  const second = await fetchGoogleNewsRss('삼성전자 005930', { fetchImpl, cache, now: () => 2_000, ttlMs: 60_000 });

  assert.equal(calls, 1);
  assert.equal(first.length, 2);
  assert.deepEqual(second, first);
});

test('json file news cache survives separate cache instances', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-search-'));
  const file = join(dir, 'cache.json');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, text: async () => sampleRss };
  };

  try {
    await fetchGoogleNewsRss('삼성전자 005930', { fetchImpl, cache: createJsonFileNewsCache(file), now: () => 1_000, ttlMs: 60_000 });
    const rows = await fetchGoogleNewsRss('삼성전자 005930', { fetchImpl, cache: createJsonFileNewsCache(file), now: () => 2_000, ttlMs: 60_000 });

    assert.equal(calls, 1);
    assert.equal(rows.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('searchStockNews builds Korean Google News RSS query', async () => {
  let requestedUrl = '';
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return { ok: true, text: async () => sampleRss };
  };

  const rows = await searchStockNews({ code: '005930', name: '삼성전자' }, { fetchImpl, cache: createNewsCache(), limit: 3 });

  assert.equal(rows.length, 2);
  assert.equal(requestedUrl, buildGoogleNewsRssUrl('삼성전자 005930'));
  assert.match(requestedUrl, /hl=ko/);
  assert.match(requestedUrl, /gl=KR/);
  assert.match(requestedUrl, /ceid=KR%3Ako/);
});
