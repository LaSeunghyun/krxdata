/**
 * ai-event-detail.mjs — 공시 원문(DART document.xml, ZIP) → 읽을 수 있는 한글 텍스트.
 *
 * 사용자 지시(2026-07-23): "공시는 타이틀만 보지 말고 세부 내용도 파악할 것".
 * 모든 공시에 rcept_no가 있어 범용으로 본문을 당긴다(타입별 구조화 API는 제각각·일부만 존재).
 * document.xml은 ZIP(내부 XML/HTML). <style> CSS·태그 제거 후 본문 텍스트만 남긴다.
 * AI 판단 엔진이 이 텍스트를 읽어 규모·방향(배정비율·계약금액·실적 YoY·순매수 등)을 파악한다.
 *
 * env: DART_API_KEY
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// adm-zip 지연 로드 — VM에 미설치여도 import 시 크래시 안 함(원문추출만 스킵, graceful).
let _AdmZip;
const getAdmZip = () => { if (_AdmZip === undefined) { try { _AdmZip = require('adm-zip'); } catch { _AdmZip = null; } } return _AdmZip; };

const KEY = () => process.env.DART_API_KEY;

/** XML/HTML → 순수 텍스트 (style/script/CSS 제거) */
export function cleanDocXml(xml) {
  return String(xml)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\.[a-zA-Z_][\w-]*\s*\{[^}]*\}/g, ' ')       // 잔여 CSS 규칙(.xforms {...})
    .replace(/[a-zA-Z-]+\s*:\s*[^;{}]{1,40};/g, ' ')      // 잔여 CSS 속성(font-size: 13pt;)
    .replace(/&[a-zA-Z]+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 공시 원문 세부 텍스트.
 * @returns {ok, text, chars} | {ok:false, note}
 */
export async function fetchDisclosureDetail(rcept_no, { maxChars = 2500 } = {}) {
  if (!KEY()) return { ok: false, note: 'DART_API_KEY 없음' };
  if (!/^\d{14}$/.test(String(rcept_no))) return { ok: false, note: 'rcept_no 형식오류' };
  let buf;
  try {
    const r = await fetch(`https://opendart.fss.or.kr/api/document.xml?crtfc_key=${KEY()}&rcept_no=${rcept_no}`, { signal: AbortSignal.timeout(20_000) });
    buf = Buffer.from(await r.arrayBuffer());
  } catch (e) { return { ok: false, note: `fetch 실패: ${String(e.message).slice(0, 60)}` }; }
  const AdmZip = getAdmZip();
  if (!AdmZip) return { ok: false, note: 'adm-zip 미설치(원문추출 스킵)' };
  try {
    const entries = new AdmZip(buf).getEntries();
    if (!entries.length) return { ok: false, note: '빈 ZIP' };
    const xml = entries.map(e => e.getData().toString('utf8')).join('\n');
    const text = cleanDocXml(xml).slice(0, maxChars);
    return text.length < 20 ? { ok: false, note: '본문 비어있음' } : { ok: true, text, chars: text.length };
  } catch (e) {
    // ZIP 아님 = 보통 status XML(013 데이터없음 등). 앞부분 반환해 원인 파악.
    const head = buf.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { ok: false, note: `unzip 실패(${head})` };
  }
}
