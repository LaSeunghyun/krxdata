/**
 * dart-doc-sections.mjs — DART 공시 원문의 목차 탐색 + 섹션 단위 조회
 *
 * 문제: `ai-event-detail.mjs`의 fetchDisclosureDetail은 전체를 평문화해 앞 maxChars만 자른다.
 * 사업보고서는 254만자(실측, 하이로닉 FY2025 기준)라 앞 2,500자는 표지·목차뿐이고
 * 직원현황·임원보수·재무 같은 실제 필요 섹션에는 절대 닿지 못한다.
 *
 * 해법: 문서를 청크로 자르지 않고 **구조를 읽는다**. DART XML은 `<TITLE ATOC="Y"
 * AASSOCNOTE="D-0-2-3-0">II. 사업의 내용</TITLE>` 형태로 목차를 그대로 담고 있어(실측:
 * TITLE 93개 중 ATOC="Y" 78개) 목차를 먼저 보여주고 지정된 섹션만 꺼내면 된다.
 *
 * 단타 공시(계약·증자 등)는 짧으므로 기존 fetchDisclosureDetail이 그대로 적합하다.
 * 이 모듈은 정기보고서(사업/반기/분기)처럼 긴 문서용이다.
 *
 * env: DART_API_KEY
 */
import { createRequire } from 'module';
import { cleanDocXml } from './ai-event-detail.mjs';

const require = createRequire(import.meta.url);
let _AdmZip;
const getAdmZip = () => {
  if (_AdmZip === undefined) { try { _AdmZip = require('adm-zip'); } catch { _AdmZip = null; } }
  return _AdmZip;
};

const KEY = () => process.env.DART_API_KEY;

// 같은 rcept_no를 목차 조회 + 섹션 조회로 두 번 당기지 않는다 (문서 하나가 300KB)
const XML_CACHE = new Map();
const CACHE_MAX = 3;

/**
 * 제목 표기로 계층을 정한다 (실측 패턴).
 *   "I. 회사의 개요" / "【 대표이사 등의 확인 】" → 1
 *   "1. 사업의 개요"                            → 2
 *   "2-1. 연결 재무상태표"                       → 3
 */
export function titleLevel(title) {
  const t = String(title).trim();
  if (/^[IVXLCDM]+\.\s*/.test(t)) return 1;
  if (/^【.*】$/.test(t)) return 1;
  if (/^\d+-\d+[.\s]/.test(t)) return 3;
  if (/^\d+[.\s]/.test(t)) return 2;
  return 2;
}

/**
 * XML에서 목차 트리를 뽑는다.
 * @returns [{ level, title, atoc, assoc, bodyStart, bodyEnd }]
 */
export function parseDocOutline(xml) {
  const src = String(xml);
  const heads = [];

  for (const m of src.matchAll(/<TITLE\b([^>]*)>([\s\S]*?)<\/TITLE>/gi)) {
    const attrs = m[1] || '';
    const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    // "목 차" 자체는 섹션이 아니다 — 본문이 없어 조회 대상이 못 된다
    if (/^목\s*차$/.test(title)) continue;
    heads.push({
      level: titleLevel(title),
      title,
      atoc: /ATOC\s*=\s*"Y"/i.test(attrs),
      assoc: /AASSOCNOTE\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? null,
      bodyStart: m.index + m[0].length,
    });
  }

  // 섹션 끝 = 같거나 더 얕은 레벨의 다음 제목 시작 (없으면 EOF) — KB 목차 파서와 같은 규칙
  for (let i = 0; i < heads.length; i++) {
    let end = src.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= heads[i].level) { end = heads[j].bodyStart; break; }
    }
    heads[i].bodyEnd = end;
  }
  return heads;
}

export function renderDocOutline(heads, { onlyToc = false } = {}) {
  const shown = onlyToc ? heads.filter(h => h.atoc) : heads;
  if (!shown.length) return '(목차 없음)';
  return shown
    .map(h => `${'  '.repeat(Math.max(0, h.level - 1))}- ${h.title}`)
    .join('\n');
}

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '').replace(/^[.\-·【】]+/, '');

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/**
 * 정확일치 → 부분일치 → 역포함 → 2-gram 겹침.
 * 마지막 단계가 필요한 이유: 호출자는 자연스러운 이름("직원 등 현황")을 쓰지만 실제 제목은
 * "1. 임원 및 직원 등의 현황"처럼 조사가 다르다(실측). 부분일치는 "등의"/"등" 차이에서 깨진다.
 */
export function findDocSection(heads, needle, { minOverlap = 0.6 } = {}) {
  const target = norm(needle);
  if (!target) return null;

  const exact = heads.find(h => norm(h.title) === target)
    ?? heads.find(h => norm(h.title).includes(target))
    ?? heads.find(h => target.includes(norm(h.title)) && norm(h.title).length >= 4);
  if (exact) return exact;

  const qb = bigrams(target);
  if (!qb.size) return null;
  let best = null, bestScore = 0;
  for (const h of heads) {
    const tb = bigrams(norm(h.title));
    let hit = 0;
    for (const g of qb) if (tb.has(g)) hit += 1;
    const score = hit / qb.size;
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return bestScore >= minOverlap ? best : null;
}

export function sectionText(xml, head, { maxChars = 6000 } = {}) {
  const raw = String(xml).slice(head.bodyStart, head.bodyEnd);
  const text = cleanDocXml(raw);
  return { text: text.slice(0, maxChars), chars: text.length, truncated: text.length > maxChars };
}

async function loadXml(rcept_no) {
  if (XML_CACHE.has(rcept_no)) return { ok: true, xml: XML_CACHE.get(rcept_no) };
  if (!KEY()) return { ok: false, note: 'DART_API_KEY 없음' };
  if (!/^\d{14}$/.test(String(rcept_no))) return { ok: false, note: 'rcept_no 형식오류' };

  let buf;
  try {
    const r = await fetch(
      `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${KEY()}&rcept_no=${rcept_no}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    buf = Buffer.from(await r.arrayBuffer());
  } catch (e) { return { ok: false, note: `fetch 실패: ${String(e.message).slice(0, 60)}` }; }

  const AdmZip = getAdmZip();
  if (!AdmZip) return { ok: false, note: 'adm-zip 미설치(원문추출 스킵)' };
  let xml;
  try {
    const entries = new AdmZip(buf).getEntries();
    if (!entries.length) return { ok: false, note: '빈 ZIP' };
    xml = entries.map(e => e.getData().toString('utf8')).join('\n');
  } catch {
    const head = buf.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { ok: false, note: `unzip 실패(${head})` };
  }

  if (XML_CACHE.size >= CACHE_MAX) XML_CACHE.delete(XML_CACHE.keys().next().value);
  XML_CACHE.set(rcept_no, xml);
  return { ok: true, xml };
}

/** 목차만 — 어느 섹션을 읽을지 고르는 단계 */
export async function fetchDisclosureOutline(rcept_no, { onlyToc = true } = {}) {
  const got = await loadXml(rcept_no);
  if (!got.ok) return { ok: false, note: got.note };
  const heads = parseDocOutline(got.xml);
  if (!heads.length) return { ok: false, note: '목차 없음(짧은 공시 → fetchDisclosureDetail 사용)' };
  return {
    ok: true,
    docChars: got.xml.length,
    sections: heads.length,
    outline: renderDocOutline(heads, { onlyToc }),
    titles: heads.map(h => h.title),
  };
}

/** 지정 섹션 본문만. 못 찾으면 목차를 돌려줘 다시 고르게 한다. */
export async function fetchDisclosureSection(rcept_no, section, { maxChars = 6000 } = {}) {
  const got = await loadXml(rcept_no);
  if (!got.ok) return { ok: false, note: got.note };
  const heads = parseDocOutline(got.xml);
  const head = findDocSection(heads, section);
  if (!head) {
    return {
      ok: false,
      note: `섹션 "${section}" 없음`,
      outline: renderDocOutline(heads, { onlyToc: true }),
    };
  }
  const { text, chars, truncated } = sectionText(got.xml, head, { maxChars });
  if (text.length < 20) return { ok: false, note: `섹션 "${head.title}" 본문 비어있음` };
  return { ok: true, title: head.title, text, chars, truncated, docChars: got.xml.length };
}
