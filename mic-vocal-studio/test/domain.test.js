const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../domain.js');

const H = 3600_000; // 1 hour ms

/* ---------- 1. calcCoachPay ---------- */
test('calcCoachPay: 시간제 — 완료 레슨 분 합산 × 시급', () => {
  const lessons = [
    { minutes: 50, amount: 80000, status: 'completed' },
    { minutes: 50, amount: 80000, status: 'completed' },
  ];
  // 100분 = 1.6667h × 30000 = 50000
  assert.equal(D.calcCoachPay(lessons, { type: 'hourly', rate: 30000 }), 50000);
});

test('calcCoachPay: 시간제 — 노쇼/환불 레슨 제외', () => {
  const lessons = [
    { minutes: 60, amount: 80000, status: 'completed' },
    { minutes: 60, amount: 80000, status: 'noshow' },
    { minutes: 60, amount: 80000, status: 'refunded' },
  ];
  assert.equal(D.calcCoachPay(lessons, { type: 'hourly', rate: 30000 }), 30000);
});

test('calcCoachPay: 매출연동 — 완료 결제액 × 요율, 환불 제외', () => {
  const lessons = [
    { minutes: 50, amount: 80000, status: 'completed' },
    { minutes: 50, amount: 90000, status: 'completed' },
    { minutes: 50, amount: 80000, status: 'refunded' },
  ];
  // (80000+90000) × 0.5 = 85000
  assert.equal(D.calcCoachPay(lessons, { type: 'revenue', rate: 0.5 }), 85000);
});

test('calcCoachPay: 빈 목록은 0', () => {
  assert.equal(D.calcCoachPay([], { type: 'hourly', rate: 30000 }), 0);
});

/* ---------- 2. calcMonthlyRevenue ---------- */
test('calcMonthlyRevenue: 해당 월 결제만 합산, 순매출 = 총-환불', () => {
  const pays = [
    { amount: 80000, refundedAmount: 0, ts: Date.parse('2026-06-03') },
    { amount: 540000, refundedAmount: 40000, ts: Date.parse('2026-06-20') },
    { amount: 75000, refundedAmount: 0, ts: Date.parse('2026-05-30') }, // 다른 달
  ];
  const r = D.calcMonthlyRevenue(pays, '2026-06');
  assert.equal(r.gross, 620000);
  assert.equal(r.refund, 40000);
  assert.equal(r.net, 580000);
  assert.equal(r.count, 2);
});

test('calcMonthlyRevenue: 데이터 없으면 0', () => {
  assert.deepEqual(D.calcMonthlyRevenue([], '2026-06'), { gross: 0, refund: 0, net: 0, count: 0 });
});

/* ---------- 3. prorateTenurePay ---------- */
test('prorateTenurePay: 월 중 퇴사 — 재직일 일할', () => {
  // 30일 월, 1~15일 재직(15일) → 월급의 15/30
  assert.equal(D.prorateTenurePay(3000000, 1, 15, 30), 1500000);
});

test('prorateTenurePay: 월 중 입사 — 입사일부터 말일', () => {
  // 30일 월, 16일 입사 → 16~30 = 15일 → 1500000
  assert.equal(D.prorateTenurePay(3000000, 16, 30, 30), 1500000);
});

test('prorateTenurePay: 풀근무는 전액', () => {
  assert.equal(D.prorateTenurePay(3000000, 1, 30, 30), 3000000);
});

/* ---------- 4. findSlotConflict ---------- */
test('findSlotConflict: 같은 강사·날짜·시간 중복은 true', () => {
  const existing = [{ coachId: 'lee', date: '2026-06-20', time: '14:00' }];
  assert.equal(D.findSlotConflict(existing, { coachId: 'lee', date: '2026-06-20', time: '14:00' }), true);
});

test('findSlotConflict: 다른 강사는 충돌 아님', () => {
  const existing = [{ coachId: 'lee', date: '2026-06-20', time: '14:00' }];
  assert.equal(D.findSlotConflict(existing, { coachId: 'kim', date: '2026-06-20', time: '14:00' }), false);
});

test('findSlotConflict: 다른 시간은 충돌 아님', () => {
  const existing = [{ coachId: 'lee', date: '2026-06-20', time: '14:00' }];
  assert.equal(D.findSlotConflict(existing, { coachId: 'lee', date: '2026-06-20', time: '15:00' }), false);
});

/* ---------- 5. isCoachBookable ---------- */
test('isCoachBookable: 활성·재직중·휴가 아님 → true', () => {
  const coach = { active: true, joinDate: '2024-01-01', leaveDate: null };
  assert.equal(D.isCoachBookable(coach, '2026-06-20', []), true);
});

test('isCoachBookable: 비활성(퇴사처리) → false', () => {
  const coach = { active: false, joinDate: '2024-01-01', leaveDate: '2026-05-31' };
  assert.equal(D.isCoachBookable(coach, '2026-06-20', []), false);
});

test('isCoachBookable: 입사일 이전 날짜 → false', () => {
  const coach = { active: true, joinDate: '2026-07-01', leaveDate: null };
  assert.equal(D.isCoachBookable(coach, '2026-06-20', []), false);
});

test('isCoachBookable: 퇴사일 이후 → false', () => {
  const coach = { active: true, joinDate: '2024-01-01', leaveDate: '2026-06-15' };
  assert.equal(D.isCoachBookable(coach, '2026-06-20', []), false);
});

test('isCoachBookable: 휴가 기간 → false', () => {
  const coach = { active: true, joinDate: '2024-01-01', leaveDate: null };
  const leaves = [{ coachId: 'lee', from: '2026-06-18', to: '2026-06-22' }];
  const c = { ...coach, id: 'lee' };
  assert.equal(D.isCoachBookable(c, '2026-06-20', leaves), false);
  assert.equal(D.isCoachBookable(c, '2026-06-25', leaves), true);
});

/* ---------- 6. calcRefund ---------- */
test('calcRefund: 24시간 이전 취소 → 전액', () => {
  const start = Date.parse('2026-06-20T14:00:00');
  const cancel = start - 25 * H;
  assert.equal(D.calcRefund(80000, start, cancel), 80000);
});

test('calcRefund: 24~2시간 전 취소 → 50%', () => {
  const start = Date.parse('2026-06-20T14:00:00');
  const cancel = start - 5 * H;
  assert.equal(D.calcRefund(80000, start, cancel), 40000);
});

test('calcRefund: 2시간 이내 취소 → 0', () => {
  const start = Date.parse('2026-06-20T14:00:00');
  const cancel = start - 1 * H;
  assert.equal(D.calcRefund(80000, start, cancel), 0);
});

test('calcRefund: 레슨 시작 후(노쇼) → 0', () => {
  const start = Date.parse('2026-06-20T14:00:00');
  assert.equal(D.calcRefund(80000, start, start + H), 0);
});

/* ---------- 7. applyScheduleChange ---------- */
test('applyScheduleChange: 시한 내·공석 → 성공, 슬롯 변경', () => {
  const booking = { coachId: 'lee', date: '2026-06-20', time: '14:00', start: Date.parse('2026-06-20T14:00:00') };
  const newSlot = { coachId: 'lee', date: '2026-06-21', time: '16:00', start: Date.parse('2026-06-21T16:00:00') };
  const now = Date.parse('2026-06-18T10:00:00'); // 충분히 이전
  const r = D.applyScheduleChange(booking, newSlot, [], now);
  assert.equal(r.ok, true);
  assert.equal(r.booking.date, '2026-06-21');
  assert.equal(r.booking.time, '16:00');
});

test('applyScheduleChange: 변경 시한(24h) 지나면 실패', () => {
  const booking = { coachId: 'lee', date: '2026-06-20', time: '14:00', start: Date.parse('2026-06-20T14:00:00') };
  const newSlot = { coachId: 'lee', date: '2026-06-21', time: '16:00', start: Date.parse('2026-06-21T16:00:00') };
  const now = Date.parse('2026-06-20T08:00:00'); // 6시간 전
  const r = D.applyScheduleChange(booking, newSlot, [], now);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_late');
});

test('applyScheduleChange: 대상 슬롯 충돌이면 실패', () => {
  const booking = { coachId: 'lee', date: '2026-06-20', time: '14:00', start: Date.parse('2026-06-20T14:00:00') };
  const newSlot = { coachId: 'lee', date: '2026-06-21', time: '16:00', start: Date.parse('2026-06-21T16:00:00') };
  const existing = [{ coachId: 'lee', date: '2026-06-21', time: '16:00' }];
  const now = Date.parse('2026-06-18T10:00:00');
  const r = D.applyScheduleChange(booking, newSlot, existing, now);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict');
});

/* ---------- 8. passRemaining ---------- */
test('passRemaining: 잔여 = 총 - 소진', () => {
  assert.deepEqual(D.passRemaining({ total: 12 }, 5), { remaining: 7, expired: false });
});

test('passRemaining: 전부 소진하면 만료', () => {
  assert.deepEqual(D.passRemaining({ total: 4 }, 4), { remaining: 0, expired: true });
});

test('passRemaining: 음수 방지(초과 소진도 0)', () => {
  assert.deepEqual(D.passRemaining({ total: 4 }, 6), { remaining: 0, expired: true });
});

test('passRemaining: 무제한(정기권)은 항상 잔여', () => {
  assert.deepEqual(D.passRemaining({ total: Infinity }, 99), { remaining: Infinity, expired: false });
});

/* ---------- usablePass — 예약 시 차감 가능한 수강권 선택 ---------- */
test('usablePass: 잔여 있는 유한 회차권을 사용 가능으로 반환', () => {
  const r = D.usablePass([{ id: 'a', name: '4회권' }], { a: 1 }, { '4회권': 4 });
  assert.equal(r.id, 'a');
});

test('usablePass: 소진된 회차권은 제외 → null', () => {
  assert.equal(D.usablePass([{ id: 'a', name: '4회권' }], { a: 4 }, { '4회권': 4 }), null);
});

test('usablePass: 무제한(정기권)은 항상 사용 가능', () => {
  assert.equal(D.usablePass([{ id: 'b', name: '정기권' }], {}, { '정기권': Infinity }).id, 'b');
});

test('usablePass: 보유 수강권 없으면 null', () => {
  assert.equal(D.usablePass([], {}, {}), null);
});

/* ---------- parseYouTubeId — 콘텐츠 관리(영상 추가) ---------- */
test('parseYouTubeId: watch?v= 형식', () => {
  assert.equal(D.parseYouTubeId('https://www.youtube.com/watch?v=gH5VAv8wg5w'), 'gH5VAv8wg5w');
});
test('parseYouTubeId: youtu.be 단축 형식', () => {
  assert.equal(D.parseYouTubeId('https://youtu.be/gH5VAv8wg5w'), 'gH5VAv8wg5w');
});
test('parseYouTubeId: embed 형식', () => {
  assert.equal(D.parseYouTubeId('https://www.youtube.com/embed/gH5VAv8wg5w?rel=0'), 'gH5VAv8wg5w');
});
test('parseYouTubeId: shorts 형식', () => {
  assert.equal(D.parseYouTubeId('https://www.youtube.com/shorts/gH5VAv8wg5w'), 'gH5VAv8wg5w');
});
test('parseYouTubeId: 11자 ID 직접 입력', () => {
  assert.equal(D.parseYouTubeId('gH5VAv8wg5w'), 'gH5VAv8wg5w');
});
test('parseYouTubeId: 부가 쿼리 포함 watch URL', () => {
  assert.equal(D.parseYouTubeId('https://www.youtube.com/watch?v=gH5VAv8wg5w&t=30s&list=abc'), 'gH5VAv8wg5w');
});
test('parseYouTubeId: 유효하지 않으면 null', () => {
  assert.equal(D.parseYouTubeId('https://example.com/video'), null);
  assert.equal(D.parseYouTubeId(''), null);
  assert.equal(D.parseYouTubeId('not a url'), null);
});

/* ---------- canAccess — 역할별 페이지 권한 ---------- */
test('canAccess: 홈·커뮤니티는 방문자 포함 전체 허용', () => {
  ['visitor','student','coach','director'].forEach(r=>{
    assert.equal(D.canAccess(r,'home'), true, r);
    assert.equal(D.canAccess(r,'community'), true, r);
  });
});
test('canAccess: 예약·마이는 로그인(student 이상)만', () => {
  assert.equal(D.canAccess('visitor','booking'), false);
  assert.equal(D.canAccess('student','booking'), true);
  assert.equal(D.canAccess('visitor','mypage'), false);
  assert.equal(D.canAccess('student','mypage'), true);
});
test('canAccess: 원장 콘솔은 director만', () => {
  assert.equal(D.canAccess('student','admin'), false);
  assert.equal(D.canAccess('coach','admin'), false);
  assert.equal(D.canAccess('director','admin'), true);
});
test('canAccess: 강사 화면은 coach·director만', () => {
  assert.equal(D.canAccess('student','coachspace'), false);
  assert.equal(D.canAccess('coach','coachspace'), true);
  assert.equal(D.canAccess('director','coachspace'), true);
});

/* ---------- 회귀: 타임존 월경계 (code-review High) ---------- */
test('calcMonthlyRevenue: UTC 자정 결제가 해당 월로 귀속 (타임존 무관)', () => {
  // America/New_York(-5) 등 음수 오프셋에서 getMonth()는 전월로 새는 버그 회귀 방지
  const pays = [{ amount: 100000, refundedAmount: 0, ts: Date.UTC(2026, 5, 1, 0, 0, 0) }];
  assert.equal(D.calcMonthlyRevenue(pays, '2026-06').gross, 100000);
});

/* ---------- 계약 보강: prorateTenurePay (code-review Med) ---------- */
test('prorateTenurePay: 퇴사일<입사일(역전) → 0', () => {
  assert.equal(D.prorateTenurePay(3000000, 20, 10, 30), 0);
});

test('prorateTenurePay: 재직일이 월일수를 넘겨도 전액 상한', () => {
  assert.equal(D.prorateTenurePay(3000000, 1, 40, 30), 3000000);
});
