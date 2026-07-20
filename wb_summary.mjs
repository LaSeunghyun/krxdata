import fs from "fs";
const d = JSON.parse(fs.readFileSync(new URL("./.wb_raw.json", import.meta.url)));
const num = s => Number(String(s ?? "0").replace(/[^0-9.-]/g, "")) || 0;
const won = n => (n/1e8).toFixed(2) + "억";
const man = n => Math.round(n/1e4).toLocaleString() + "만원";

for (const y of ["2025","2024","2023"]) {
  const Y = d[y]; if (!Y) continue;
  console.log(`\n===== ${y} 사업연도 =====`);

  // 직원: 부문별 집계
  const rows = Y.empStatus.rows;
  const byDiv = {};
  for (const r of rows) {
    const div = r.부문;
    byDiv[div] ??= { head:0, total:0 };
    byDiv[div].head  += num(r.합계);
    byDiv[div].total += num(r.연간급여총액);
  }
  let allHead=0, allTotal=0;
  console.log("[직원 부문별]");
  for (const [div,v] of Object.entries(byDiv)) {
    allHead+=v.head; allTotal+=v.total;
    console.log(`  ${div}: ${v.head}명, 급여총액 ${won(v.total)}, 1인평균 ${man(v.total/v.head)}`);
  }
  console.log(`  [전체] ${allHead}명, 1인평균 ${man(allTotal/allHead)}`);
  const rnd = byDiv["연구직"];
  if (rnd) console.log(`  >> 연구소(연구직) 평균연봉: ${man(rnd.total/rnd.head)} (${rnd.head}명)`);

  // 임원: 이사·감사 전체 보수현황
  const all = Y.hmvAuditAllSttus;
  if (Array.isArray(all)) for (const r of all)
    console.log(`[이사·감사 전체] 인원 ${r.nmpr}명, 보수총액 ${won(num(r.mendng_totamt))}, 1인평균 ${man(num(r.jan_avrg_mendng_am))}`);

  // 유형별
  const ty = Y.drctrAdtAllMendngSttusMendngPymntamtTyCl;
  if (Array.isArray(ty)) {
    console.log("[유형별 보수]");
    for (const r of ty) {
      if (num(r.nmpr)===0) continue;
      console.log(`  ${r.se}: ${r.nmpr}명, 총 ${won(num(r.pymnt_totamt))}, 1인평균 ${man(num(r.psn1_avrg_pymntamt))}`);
    }
  }

  // 재무
  const f = Y.financials;
  if (f) console.log(`[재무 ${f.fs_div}] 매출 ${won(num(f.매출액?.당기))}, 영업이익 ${won(num(f.영업이익?.당기))}, 자산 ${won(num(f.자산총계?.당기))}, 자본 ${won(num(f.자본총계?.당기))}, 부채 ${won(num(f.부채총계?.당기))}`);
}
