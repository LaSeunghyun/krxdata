/* =========================================================
   MIC VOCAL — 도메인 로직 (순수 함수, node·browser 공용 UMD)
   유저스토리 갭에서 도출. 전 함수 TDD(test/domain.test.js).
========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DOMAIN = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const HOUR = 3600000;
  const round = n => Math.round(n);

  /* 1. 강사 수당 — 시간제(분×시급) 또는 매출연동(결제액×요율) */
  function calcCoachPay(lessons, policy) {
    const done = (lessons || []).filter(l => l.status === 'completed');
    if (policy.type === 'hourly') {
      const mins = done.reduce((s, l) => s + (l.minutes || 0), 0);
      return round((mins / 60) * policy.rate);
    }
    if (policy.type === 'revenue') {
      const rev = done.reduce((s, l) => s + (l.amount || 0), 0);
      return round(rev * policy.rate);
    }
    return 0;
  }

  /* 2. 월 매출 — 해당 월 결제합 − 환불 = 순매출
     월 분류는 UTC 기준으로 결정론적(타임존 무관) 처리 */
  function calcMonthlyRevenue(payments, yyyymm) {
    let gross = 0, refund = 0, count = 0;
    (payments || []).forEach(p => {
      const d = new Date(p.ts);
      const key = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
      if (key !== yyyymm) return;
      gross += p.amount || 0;
      refund += p.refundedAmount || 0;
      count += 1;
    });
    return { gross, refund, net: gross - refund, count };
  }

  /* 3. 입·퇴사 월 일할 정산 — 재직일은 0~월일수로 clamp */
  function prorateTenurePay(monthlySalary, joinDay, leaveDay, daysInMonth) {
    const days = Math.min(daysInMonth, Math.max(0, leaveDay - joinDay + 1));
    return round(monthlySalary * (days / daysInMonth));
  }

  /* 4. 슬롯 충돌 — 같은 강사·날짜·시간 */
  function findSlotConflict(existing, candidate) {
    return (existing || []).some(s =>
      s.coachId === candidate.coachId && s.date === candidate.date && s.time === candidate.time);
  }

  /* 5. 강사 예약 가능 — 활성·재직중·휴가 아님 */
  function isCoachBookable(coach, date, leaves) {
    if (!coach || !coach.active) return false;
    if (coach.joinDate && date < coach.joinDate) return false;
    if (coach.leaveDate && date > coach.leaveDate) return false;
    const onLeave = (leaves || []).some(lv =>
      lv.coachId === coach.id && date >= lv.from && date <= lv.to);
    return !onLeave;
  }

  /* 6. 환불액 — 24h전 100% / 24~2h 50% / 2h내·노쇼 0% */
  function calcRefund(amount, lessonStart, cancelAt) {
    const diff = lessonStart - cancelAt;
    if (diff >= 24 * HOUR) return amount;
    if (diff >= 2 * HOUR) return round(amount * 0.5);
    return 0;
  }

  /* 7. 스케줄 변경 — 시한(24h) + 대상 슬롯 공석 */
  function applyScheduleChange(booking, newSlot, existing, now) {
    if (booking.start - now < 24 * HOUR) return { ok: false, reason: 'too_late' };
    if (findSlotConflict(existing, newSlot)) return { ok: false, reason: 'conflict' };
    return { ok: true, booking: Object.assign({}, booking, newSlot) };
  }

  /* 8. 수강권 잔여 회차 — 무제한(정기권)은 항상 잔여 */
  function passRemaining(pass, used) {
    if (pass.total === Infinity || pass.total == null) return { remaining: Infinity, expired: false };
    const remaining = Math.max(0, pass.total - (used || 0));
    return { remaining, expired: remaining <= 0 };
  }

  /* 9. 예약 시 차감 가능한 수강권 선택 (잔여>0 또는 무제한 중 첫 건) */
  function usablePass(passes, usedMap, totals) {
    return (passes || []).find(p => {
      const total = totals[p.name];
      if (total === Infinity) return true;
      if (!total) return false;
      return passRemaining({ total }, (usedMap || {})[p.id] || 0).remaining > 0;
    }) || null;
  }

  /* 10. 유튜브 URL/ID에서 11자 videoId 추출 (콘텐츠 관리) */
  function parseYouTubeId(input) {
    if (!input || typeof input !== 'string') return null;
    const s = input.trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  /* 11. 역할별 페이지 접근 권한 */
  var ACCESS = {
    home: ['visitor', 'student', 'coach', 'director'],
    community: ['visitor', 'student', 'coach', 'director'],
    booking: ['student', 'coach', 'director'],
    mypage: ['student', 'coach', 'director'],
    coachspace: ['coach', 'director'],
    admin: ['director'],
  };
  function canAccess(role, page) {
    return (ACCESS[page] || []).indexOf(role) !== -1;
  }

  return {
    calcCoachPay, calcMonthlyRevenue, prorateTenurePay, findSlotConflict,
    isCoachBookable, calcRefund, applyScheduleChange, passRemaining, usablePass,
    parseYouTubeId, canAccess
  };
}));
