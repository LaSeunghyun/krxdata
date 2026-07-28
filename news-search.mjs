import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search';
const DEFAULT_LOCALE = Object.freeze({ hl: 'ko', gl: 'KR', ceid: 'KR:ko' });
export const DEFAULT_NEWS_TTL_MS = 6 * 60 * 60 * 1000;

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createNewsCache() {
  return new Map();
}

export function createJsonFileNewsCache(filePath = join(__dirname, '.news-search-cache.json')) {
  let loaded = false;
  const mem = new Map();
  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      if (!existsSync(filePath)) return;
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      for (const [key, value] of Object.entries(raw)) mem.set(key, value);
    } catch {
      mem.clear();
    }
  };
  const save = () => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(Object.fromEntries(mem), null, 1));
    } catch {
      // Cache writes are best-effort; news lookup should not block trading shadow runs.
    }
  };
  return {
    get(key) { load(); return mem.get(key); },
    set(key, value) { load(); mem.set(key, value); save(); return this; },
    clear() { load(); mem.clear(); save(); },
  };
}

const defaultCache = createJsonFileNewsCache();

function decodeXml(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, ent) => {
    if (ent === 'amp') return '&';
    if (ent === 'lt') return '<';
    if (ent === 'gt') return '>';
    if (ent === 'quot') return '"';
    if (ent === 'apos') return "'";
    const base = ent.toLowerCase().startsWith('#x') ? 16 : 10;
    const raw = ent.replace(/^#x?/i, '');
    const code = Number.parseInt(raw, base);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}

function compactText(text) {
  return decodeXml(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValue(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  return block.match(re)?.[1] ?? '';
}

function toIsoOrRaw(value) {
  const raw = compactText(value);
  if (!raw) return '';
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : raw;
}

export function buildGoogleNewsRssUrl(query, { hl = DEFAULT_LOCALE.hl, gl = DEFAULT_LOCALE.gl, ceid = DEFAULT_LOCALE.ceid } = {}) {
  const params = new URLSearchParams({ q: String(query ?? '').trim(), hl, gl, ceid });
  return `${GOOGLE_NEWS_RSS}?${params.toString()}`;
}

export function parseGoogleNewsRss(xml, { limit = 3 } = {}) {
  const rows = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(String(xml ?? ''))) && rows.length < limit) {
    const item = match[1];
    rows.push({
      title: compactText(tagValue(item, 'title')),
      source: compactText(tagValue(item, 'source')),
      link: compactText(tagValue(item, 'link')),
      published: toIsoOrRaw(tagValue(item, 'pubDate')),
      snippet: compactText(tagValue(item, 'description')),
    });
  }
  return rows.filter(row => row.title || row.link || row.snippet);
}

export async function fetchGoogleNewsRss(query, {
  fetchImpl = globalThis.fetch,
  cache = defaultCache,
  now = () => Date.now(),
  ttlMs = DEFAULT_NEWS_TTL_MS,
  limit = 3,
  timeoutMs = 10_000,
  locale,
} = {}) {
  if (!fetchImpl || !String(query ?? '').trim()) return [];
  const url = buildGoogleNewsRssUrl(query, locale);
  const hit = cache?.get(url);
  if (hit && now() - hit.savedAt < ttlMs) return hit.items;
  try {
    const opts = timeoutMs && globalThis.AbortSignal?.timeout
      ? { signal: AbortSignal.timeout(timeoutMs) }
      : {};
    const res = await fetchImpl(url, opts);
    if (!res?.ok) return [];
    const items = parseGoogleNewsRss(await res.text(), { limit });
    cache?.set(url, { savedAt: now(), items });
    return items;
  } catch {
    return [];
  }
}

export async function searchStockNews({ code, name }, opts = {}) {
  const query = [name, code].filter(Boolean).join(' ');
  return fetchGoogleNewsRss(query, opts);
}
