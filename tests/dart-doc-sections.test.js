import test from 'node:test';
import assert from 'node:assert/strict';
import {
  titleLevel, parseDocOutline, renderDocOutline, findDocSection, sectionText,
} from '../dart-doc-sections.mjs';

// 실측 구조를 그대로 축소한 픽스처 (하이로닉 FY2025 사업보고서 rcept_no=20260324000020 기준)
const XML = `<DOCUMENT>
<DOCUMENT-NAME>사업보고서</DOCUMENT-NAME>
<SECTION-1 ACLASS="MANDATORY" APARTSOURCE="SOURCE">
<TITLE ATOC="N" ENG="Table of Contents">목              차</TITLE>
<P>목차 더미</P>
<TITLE ATOC="Y" AASSOCNOTE="TTL_CEO_CERT" ENG="Confirmation">【 대표이사 등의 확인 】</TITLE>
<P>대표이사 확인 본문입니다.</P>
<TITLE ATOC="Y" ENG="I. Company Overview" ATOCID="3">I. 회사의 개요</TITLE>
<TITLE ATOC="Y" AASSOCNOTE="D-0-1-1-0" ENG="1. Company overview" ATOCID="4">1. 회사의 개요</TITLE>
<P>회사 개요 본문. 설립일과 주소가 들어갑니다.</P>
<TITLE ATOC="Y" AASSOCNOTE="D-0-1-2-0" ENG="2. Company history" ATOCID="5">2. 회사의 연혁</TITLE>
<P>연혁 본문.</P>
<TITLE ATOC="Y" AASSOCNOTE="D-0-2-0-0" ENG="II. Business Description">II. 사업의 내용</TITLE>
<TITLE ATOC="Y" AASSOCNOTE="L-0-2-1-L1" ENG="1. Business overview">1. 사업의 개요</TITLE>
<P>사업 개요 본문. 주력 제품은 의료기기입니다.</P>
<TITLE ATOC="Y" AASSOCNOTE="D-0-3-0-0" ENG="III. Financial Matters">III. 재무에 관한 사항</TITLE>
<TITLE ATOC="Y" AASSOCNOTE="D-0-3-2-0" ENG="2. Consolidated FS">2. 연결재무제표</TITLE>
<TITLE ATOC="Y" ENG="2-1. Consolidated SoFP">2-1. 연결 재무상태표</TITLE>
<style>.xforms { font-size: 13pt; }</style>
<TABLE><TR><TD>자산총계</TD><TD>1,234</TD></TR></TABLE>
<TITLE ATOC="Y" AASSOCNOTE="D-0-8-0-0" ENG="VIII. Officers and Employees">VIII. 임원 및 직원 등에 관한 사항</TITLE>
<TITLE ATOC="N" ENG="2. Employee status">2. 직원 등 현황</TITLE>
<P>직원수 총 123명, 1인 평균 급여액 52백만원.</P>
</SECTION-1>
</DOCUMENT>`;

test('titleLevel — 실측 표기 패턴으로 계층 판정', () => {
  assert.equal(titleLevel('I. 회사의 개요'), 1);
  assert.equal(titleLevel('VIII. 임원 및 직원 등에 관한 사항'), 1);
  assert.equal(titleLevel('【 대표이사 등의 확인 】'), 1);
  assert.equal(titleLevel('1. 사업의 개요'), 2);
  assert.equal(titleLevel('2-1. 연결 재무상태표'), 3);
  assert.equal(titleLevel('기타 참고사항'), 2);
});

test('parseDocOutline — TITLE 태그에서 목차 추출, "목 차"는 제외', () => {
  const heads = parseDocOutline(XML);
  const titles = heads.map(h => h.title);
  assert.ok(!titles.some(t => /^목\s*차$/.test(t)), '"목 차"는 섹션이 아니므로 제외');
  assert.ok(titles.includes('I. 회사의 개요'));
  assert.ok(titles.includes('2. 직원 등 현황'));
  assert.equal(heads.find(h => h.title === '1. 회사의 개요').assoc, 'D-0-1-1-0');
  assert.equal(heads.find(h => h.title === '2. 직원 등 현황').atoc, false);
  assert.equal(heads.find(h => h.title === 'I. 회사의 개요').atoc, true);
});

test('parseDocOutline — 섹션 경계: 같거나 얕은 레벨의 다음 제목까지', () => {
  const heads = parseDocOutline(XML);
  for (const h of heads) assert.ok(h.bodyStart < h.bodyEnd, `${h.title}: start<end`);

  // level 1 "I. 회사의 개요"는 하위 "1.", "2."를 품고 다음 level 1 "II."에서 끝난다
  const co = heads.find(h => h.title === 'I. 회사의 개요');
  const biz = heads.find(h => h.title === 'II. 사업의 내용');
  assert.equal(co.bodyEnd, biz.bodyStart);
  const coText = sectionText(XML, co).text;
  assert.match(coText, /회사 개요 본문/);
  assert.match(coText, /연혁 본문/);
  assert.ok(!coText.includes('사업 개요 본문'), 'II 이후는 포함하지 않아야 함');

  // level 2는 자기 범위만
  const sub = heads.find(h => h.title === '1. 회사의 개요');
  const subText = sectionText(XML, sub).text;
  assert.match(subText, /회사 개요 본문/);
  assert.ok(!subText.includes('연혁 본문'), '형제 섹션 침범 금지');
});

test('sectionText — CSS·태그 제거하고 표 내용은 살린다', () => {
  const heads = parseDocOutline(XML);
  const fs = heads.find(h => h.title === '2-1. 연결 재무상태표');
  const { text } = sectionText(XML, fs);
  assert.match(text, /자산총계/);
  assert.match(text, /1,234/);
  assert.ok(!text.includes('font-size'), 'CSS 잔재 없어야 함');
  assert.ok(!text.includes('<TD>'), '태그 없어야 함');
});

test('sectionText — maxChars 초과 시 truncated 표시', () => {
  const heads = parseDocOutline(XML);
  const h = heads.find(x => x.title === 'I. 회사의 개요');
  const r = sectionText(XML, h, { maxChars: 10 });
  assert.equal(r.text.length, 10);
  assert.equal(r.truncated, true);
  assert.ok(r.chars > 10, 'chars는 잘리기 전 실제 길이');
});

test('findDocSection — 정확일치·부분일치·역포함', () => {
  const heads = parseDocOutline(XML);
  assert.equal(findDocSection(heads, 'II. 사업의 내용').title, 'II. 사업의 내용');
  assert.equal(findDocSection(heads, '직원 등 현황').title, '2. 직원 등 현황');
  assert.equal(findDocSection(heads, '재무상태표').title, '2-1. 연결 재무상태표');
  assert.equal(findDocSection(heads, '없는섹션xyz'), null);
  assert.equal(findDocSection(heads, ''), null);
});

test('findDocSection — 2-gram 겹침으로 조사 변형 흡수 (실측 케이스)', () => {
  // 실측: 하이로닉 FY2025 실제 제목은 "1. 임원 및 직원 등의 현황"인데
  // 호출자는 보통 "직원 등 현황"이라 쓴다 → 부분일치는 "등의"/"등"에서 깨진다
  const heads = parseDocOutline(`<DOCUMENT>
<TITLE ATOC="Y">VIII. 임원 및 직원 등에 관한 사항</TITLE>
<TITLE ATOC="Y">1. 임원 및 직원 등의 현황</TITLE><P>직원수 총 123명.</P>
<TITLE ATOC="Y">2. 임원의 보수 등</TITLE><P>보수총액 715백만원.</P>
</DOCUMENT>`);
  assert.equal(findDocSection(heads, '직원 등 현황').title, '1. 임원 및 직원 등의 현황');
  assert.equal(findDocSection(heads, '임원의 보수').title, '2. 임원의 보수 등');
  // 임계값 미달은 매칭하지 않는다 (아무거나 집어오면 더 나쁘다)
  assert.equal(findDocSection(heads, '전환사채 발행내역'), null);
  assert.equal(findDocSection(heads, '유형자산 손상차손'), null);
});

test('findDocSection — 동일 제목이 레벨별로 있으면 먼저 나온 것 (I. 회사의 개요 vs 1. 회사의 개요)', () => {
  const heads = parseDocOutline(XML);
  // "1. 회사의 개요"는 정확일치로 하위 섹션을 집는다
  assert.equal(findDocSection(heads, '1. 회사의 개요').title, '1. 회사의 개요');
  assert.equal(findDocSection(heads, 'I. 회사의 개요').title, 'I. 회사의 개요');
});

test('renderDocOutline — onlyToc이 ATOC="N" 섹션을 걸러낸다', () => {
  const heads = parseDocOutline(XML);
  const all = renderDocOutline(heads);
  const toc = renderDocOutline(heads, { onlyToc: true });
  assert.match(all, /2\. 직원 등 현황/);
  assert.ok(!toc.includes('2. 직원 등 현황'), 'ATOC="N"은 목차 모드에서 제외');
  assert.match(toc, /I\. 회사의 개요/);
  // 들여쓰기로 계층 표현
  assert.match(all, /^- I\. 회사의 개요$/m);
  assert.match(all, /^ {2}- 1\. 회사의 개요$/m);
  assert.match(all, /^ {4}- 2-1\. 연결 재무상태표$/m);
});

test('parseDocOutline — 목차 없는 짧은 공시는 빈 배열', () => {
  assert.deepEqual(parseDocOutline('<DOCUMENT><P>계약 체결 안내</P></DOCUMENT>'), []);
  assert.deepEqual(parseDocOutline(''), []);
});
