import fs from "fs";
const d = JSON.parse(fs.readFileSync(new URL("./.wb_raw.json", import.meta.url)));
const num = s => Number(String(s ?? "0").replace(/[^0-9.-]/g, "")) || 0;
const man = n => Math.round(n/1e4).toLocaleString();      // 원→만원
for (const y of ["2025","2024"]) {
  const Y = d[y]; if (!Y) continue;
  console.log(`\n===== ${y} 사업보고서 =====`);
  console.log("[직원 부문×성별]  인원 / 연봉(만원) / 월평균(만원)  ※상여 포함 평균");
  for (const r of Y.empStatus.rows) {
    const head = num(r.합계), tot = num(r.연간급여총액);
    const yr = head ? tot/head : 0;
    console.log(`  ${r.부문}/${r.성별}: ${head}명  ·  연 ${man(yr)}  ·  월 ${man(yr/12)}  (평균근속 ${r.평균근속}년)`);
  }
  console.log("[임원]  인원 / 1인연봉(만원) / 월평균(만원)");
  const ty = Y.drctrAdtAllMendngSttusMendngPymntamtTyCl;
  if (Array.isArray(ty)) for (const r of ty) {
    if (num(r.nmpr)===0) continue;
    const avg = num(r.psn1_avrg_pymntamt);
    console.log(`  ${r.se}: ${r.nmpr}명  ·  연 ${man(avg)}  ·  월 ${man(avg/12)}`);
  }
  const all = Y.hmvAuditAllSttus;
  if (Array.isArray(all)) for (const r of all) {
    const avg = num(r.jan_avrg_mendng_am);
    console.log(`  (이사·감사 전체) ${r.nmpr}명  ·  연 ${man(avg)}  ·  월 ${man(avg/12)}`);
  }
}
