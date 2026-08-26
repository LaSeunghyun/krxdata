# 예약청산 소유권 가드 설계 (2026-08-26)

## 배경

사용자가 토스 앱에서 직접 매수한 에이치브이엠(295310)이 봇에 의해 3회 강제청산됐다.

| 시각 | 수량 | 체결가 | 실현 | 예약 출처 |
|---|---|---|---|---|
| 2026-08-19 08:00:42 | 331 | 47,553 | -13.8% | 08-18 AI 판단 |
| 2026-08-26 08:00:44 | 147 / 주문 326 | 48,000 | -0.6% | 08-25 09:33 AI 판단 |
| 2026-08-26 08:06:47 | 322 | 48,273 | -0.4% | 같은 예약 (재매수분 143주 포함) |

세 번째 건은 사용자가 08:02~08:06 사이에 재매수한 143주까지 6분 만에 청산했다.
저널 평단이 48,286.66 → 48,450 으로 변한 것이 재매수의 물증이다(매도는 평단을 바꾸지 않는다).

### 원인 - 보호 4겹이 전부 이 경로를 못 막았다

1. `.bot-exclude.json`(유일한 실질 보호, `stock-live.mjs:952-953` items 필터)은 **tg-order 텔레그램 매수로만 등록된다.** 토스 앱 직접 매수는 영원히 미등록. `tg_order_queue` 전체 이력 2건뿐(07-23, 07-31).
2. `sub 미상 → 자동청산 보류`(`stock-live.mjs:1169`)는 `else if` 라서, 위의 예약청산 분기(`:1147`)가 먼저 잡으면 **도달 불가 코드**가 된다.
3. `sellOk`(`ai-trader.mjs:303`)는 held / exit_reserved / ca_hold 3개만 본다. `sub === null` 미검사. 바로 아래 `deferOk`(`:314`)는 `sub === 'rsi2'` 를 요구한다 - **팔 수는 있는데 손절유예는 못 받는 비대칭.**
4. aiExitPark(AI 예약 vs 기계판정 경합, 08-01 방어)는 `judgeExitsAtClose:705` 의 `if (m.sub!=='rsi2' && m.sub!=='hi120') continue` 에서 먼저 탈락한다. 실측: journal 전체에서 `종가판정[` 발화 **0건**.

**시점:** `547eff3`(08-01 11:33) AI 청산예약 도입 → `f268838`(08-01 16:23) sub 미상 보호 추가. 보호가 5시간 뒤에 AI 경로 *아래* 붙었다. 규칙이 바뀐 것이 아니라 처음부터 구멍이었다.

### 부수 결함

- **예약청산이 수량에 안 묶인다:** `qty = Number(it.quantity)`(`:1017`)로 브로커 보유수량을 실시간으로 읽는다. 생성 시점 수량(326)과 무관.
- **당일매수 방어 미배선:** `minHoldDays:1`(`strategy-contract.mjs:378`)은 `rotOk` 에만, `soldToday` 는 봇 매수에만. 예약청산 집행부는 보유일수를 조회하지 않는다. `soldToday` 는 전량체결 분기에서만 세워져 08:00 부분체결 때는 무장조차 안 됐다.
- **수동 포지션은 hold_days 가 영구 null:** 입양 meta 가 `{hi, entry}` 뿐(`:1029`). `boughtAt` 이 없다.
- **사유가 22.5시간 얼어붙는다:** 사유 "간밤 미 반도체 SOXX -4%" 는 08-24 미국장. 집행 직전 08-25 미국장은 SOXX +1.56% / 나스닥 +0.66% / AMD +4.91% 로 반등했다. 재검증 게이트가 없다.
- **아침 브리핑도 1세션 stale:** 08-26 07:05 브리핑이 "8/25 마감" 이라며 적은 지수 레벨 3개(7,652.86 / 25,980.19 / 53,417.16)가 08-25 브리핑의 "8/24 마감" 값과 글자 그대로 동일. 실제 08-25 종가는 S&P 7,677.28 / 나스닥 26,151.30.

### AI 청산예약 실적

```
AI 예약청산 : 3건 · 평균 -4.93% · 승 0/3   (전부 295310, 전부 사용자 포지션)
기계 청산   : 30건 · 평균 -0.29% · 승 11/30
```

패치 (1) 적용 후 AI 청산예약의 **유효 실적 표본은 0건**이 된다. 실계좌 자동집행 중인데 검증 표본이 0인 기능이다.

---

## 목표

1. 봇이 직접 사지 않은 포지션을 봇이 자동으로 팔 수 없게 한다.
2. 예약청산이 예약 시점 수량을 넘어 팔 수 없게 한다.
3. AI 청산권고를 사람 승인 아래 둔다(매수와 동일한 A+C 모델).
4. 위 셋이 **실행 경로에 실제로 도달하는지** 기계로 검증한다.

### 비-목표 (YAGNI)

- 기계 신선도 게이트(브리핑 날짜 대조, 지수레벨 재탕 검출). (4)가 사람에게 `briefDay` 를 보여주므로 불필요.
- 집행 직전 AI 재호출. 판단자가 같은 AI · 같은 브리핑이라 실효가 없다.
- 브로커에서 실제 매수일 조회. 토스 `/api/v1/holdings` 에 매수일 필드가 없다(실측). 저널이 유일한 출처.
- 브리핑 생성 로직 수정. 별건으로 분리한다.

---

## 확정된 설계 결정

| # | 결정 | 대안 대비 이유 |
|---|---|---|
| D1 | sub 미상 포지션은 **발견 즉시 자동 격리** | 격리는 "봇이 무시" 가 아니라 "사용자 소유" 관리 모드다. `emitSellSignals`(`:864`)가 `manualCodes.has()` 로 필터해 **격리된 종목만** 매도사인 알림을 받는다. 기능을 잃는 게 아니라 바꾸는 것 |
| D2 | 소유 판정은 **저널 대조** | `sub 미상` 은 "사용자 것" 과 "봇 것인데 meta 유실" 둘 다를 뜻한다. 후자를 격리하면 검증된 -15% 손절이 조용히 사라진다. 저널 BUY 레코드는 `sub` 를 포함하고(`:1807`) 원자쓰기+`.bak`(`:424-435`)이라 state 보다 견고 |
| D3 | 봇 보유분 + 사용자 추가매수는 **exitQty 상한** | 격리로 처리하면 1주만 더 사도 봇의 검증된 포지션 관리가 통째로 끊긴다. 과잉반응 |
| D4 | AI 청산권고는 **사람 승인 필수** | 매수는 이미 사람 승인인데 매도만 자동인 비대칭. (1) 이후 유효 표본 0건 |
| D5 | 소유 판정 로직은 **순수모듈로 추출** | `stock-live.mjs` 는 top-level await + 무한루프라 import 불가(`tests/strategy-contract.test.js` 주석). 인라인이면 소스 정규식 대조밖에 못 하고, 이번 결함이 정확히 "소스에는 있는데 실행 안 됨" 이다 |
| D6 | 파일마다 **writer 1개**, 락 없음 | (1)이 `.bot-exclude.json` 에 두 번째 writer 를 만든다. `addBotExclude`(`bot-exclude.mjs:17`)는 락 없는 read-modify-write. `forecast-llm` flock 누락 전례를 보면 락은 빠뜨리기 쉽다 |
| D7 | telegram-agent → stock-live 는 **append-only 요청 로그 + 소비 커서** | `격리해제` 는 재격리 루프를 유발하므로(sub 미상이 그대로) stock-live 가 처리까지 해야 한다. 승인과 격리해제 둘 다 단방향 요청이라 채널 1개로 통합 |
| D8 | **봇이 산 적 없는 종목의 `격리해제` 는 거부한다** (스펙 셀프리뷰에서 도출) | 적용할 검증된 규칙이 없다. 임의 `sub` 를 붙이면 폐지된 장중 손절·트레일 경로(청산건당 -0.69%p)로 떨어진다. `sub:'adopted'` 라는 신규 상태를 만들지 않는 쪽이 맞다. 상세는 아래 패치 (4) |

---

## 아키텍처

```
position-ownership.mjs  [신규·순수함수·import 가능]
   classifyPosition()  -- 소유 판정의 단일 출처

stock-live.mjs          [수정] 판정 호출 · 자동격리 · exitQty · 요청 소비 · 제안 등록
ai-trader.mjs           [수정] sellOk 대칭 (sub · hold_days)
bot-exclude.mjs         [수정] 두 파일 합집합 읽기 + addBotExcludeAuto
telegram-agent.mjs      [수정] 청산승인 파서 · 요청 append

.bot-exclude-auto.json  [신규] writer = stock-live 단독
.tg-requests.jsonl      [신규] writer = telegram-agent 단독, append-only
state.aiExitPending     [신규] stock-live state 내부 (제안 보관)
state.tgReqCursor       [신규] stock-live state 내부 (요청 소비 위치)
```

---

## 컴포넌트

### `position-ownership.mjs` (신규)

```js
export function botHeldQty(trades, code)
// 저널에서 code 의 BUY qty 합 - SELL qty 합.
// 음수면 클램프하지 않고 그대로 반환한다(음수 = 데이터 이상 → 호출부가 user 로 떨어뜨린다).

export function classifyPosition({ code, brokerQty, currentPx, meta, trades })
// → { kind: 'bot' | 'user' | 'unknown', why, restoreMeta? }
```

판정 순서:

| 조건 | 결과 |
|---|---|
| `meta?.sub` 있음 | `bot` (이미 관리 중, 판정 불필요) |
| `trades` 가 배열이 아님 | `unknown` (판정 보류) |
| `botQty > 0` 이고 `botQty >= brokerQty` | `bot` + `restoreMeta` |
| 그 외 | `user` |

`restoreMeta` 는 저널의 마지막 미청산 BUY 에서 만든다:
`{ sub, boughtAt: ts, entry: px, hi: Math.max(px, currentPx) }`

`hi` 를 진입가 이상으로만 잡는 이유: 진입 후 실제 고점을 모른다. 낮게 잡으면 트레일이 늦게 걸린다 = 덜 파는 쪽 = 안전측.
실제 손익 판정은 청산 루프가 브로커 `averagePurchasePrice` 를 쓰므로(`:1017`, `:755` 주석) `entry` 는 참고값이다.

### `bot-exclude.mjs` (수정)

```js
readBotExclude()           // .bot-exclude.json 과 .bot-exclude-auto.json 의 합집합  (변경)
addBotExclude(code)        // 수동 파일에만 write   (기존, tg-order / telegram-agent 전용)
removeBotExclude(code)     // 수동 파일에서만 제거  (기존, 동작 불변)
addBotExcludeAuto(code)    // 자동 파일에만 write   (신규, stock-live 전용)
removeBotExcludeAuto(code) // 자동 파일에서만 제거  (신규, stock-live 전용)
```

**D6 준수:** `removeBotExclude` 를 "두 파일 모두 제거" 로 만들면 tg-order 가 자동 파일의 두 번째 writer 가 된다. 그래서 제거도 파일별로 분리한다. `격리해제` 는 두 파일에 걸쳐 있으므로 **각 파일의 소유자가 각자 처리한다** - telegram-agent 가 수동 파일에서 직접 제거하고, 자동 파일 쪽은 `.tg-requests.jsonl` 에 요청을 남겨 stock-live 가 처리한다.

---

## 패치

### (1) 자동 격리 + meta 복원

위치: `stock-live.mjs:952` 의 `EXCLUDED` / `items` 구성 **직전**.

```
원시보유(marketCountry==='KR', qty>0) 각각:
  이미 EXCLUDED → skip
  classifyPosition({ code, brokerQty, currentPx, meta: state.meta[code], trades })
    'bot' + restoreMeta → state.meta[code] = restoreMeta
                          log + tgNotify("meta 복원 - 봇 규칙 재적용")
    'user'              → addBotExcludeAuto(code)
                          log + tgNotify("자동 격리")
    'unknown'           → 아무 조치 없음 + 하루 1회 경보
→ 그 뒤 EXCLUDED 를 다시 읽어 items 를 구성한다
```

저널은 mtime 기반 캐시로 읽는다(현재 17KB / 67건이나 30초 루프이므로).

격리 알림 문구:

```
⚠️ {종목}({코드}) 을 자동 격리했습니다.
봇이 산 것이 아니라 건들지 않습니다.
목표·손절 도달 시 알림만 보냅니다.
봇에게 돌려주려면: 격리해제 {종목명}
```

### (2) exitQty 상한

`m.exitAt` 대입 지점은 3곳이다(grep 실측): `:826` 기계판정, `:1475` AI(승인 경로로 이동), `:745` / `:824` unpark 복원. 전부 `m.exitQty` 를 같이 세운다.

```
예약 생성:  m.exitQty = qty                       // 그 시점 보유수량
집행:       const cap  = Number(m.exitQty ?? qty) // 폴백 = 현행 동작
            const base = Math.min(qty, cap)
            if (base <= 0) { 예약 해제(exitAt/exitDay/exitFrac/exitQty 삭제) + 로그; continue }
            sellQty    = frac >= 1 ? base : Math.max(1, Math.floor(base * frac))
부분체결:   m.exitQty = cap - fq                  // 0 이 되면 다음 사이클에 위 분기가 예약을 해제한다
```

`base <= 0` 분기가 필요한 이유: 예약 수량이 전부 소진됐는데 사용자가 새로 사서 브로커 보유수량이 다시 0 보다 커진 경우, 이 분기가 없으면 `Math.max(1, ...)` 가 **1주를 판다.** 오늘 사고의 축소판이 된다.

오늘 재현: `08:00 min(326,326)=326` → 147 체결 → `cap=179` → `08:06 min(322,179)=179` → 재매수 143주 잔존.

### (3) `sellOk` 대칭 (`ai-trader.mjs:303`)

```diff
  const sellOk = (x) => {
    const h = heldMap.get(x.code);
-   return !!h && !h.exit_reserved && !h.ca_hold;
+   if (!h || h.exit_reserved || h.ca_hold) return false;
+   if (h.sub == null) return false;
+   if (typeof h.hold_days !== 'number' || h.hold_days < R.minHoldDays) return false;
+   return true;
  };
```

`rotOk`(`:340`)가 이미 쓰는 것과 같은 조건이다. (1)의 `unknown` 창(저널 읽기 실패)에서 백스톱이 된다.

### (4) AI 청산 = 사람 승인

**제안 등록** (`:1465~1478` 대체)

```
state.aiExitPending[code] = { why, briefDay, at: now(), expiresAt: 당일 20:00 KST }
tgNotify:
  📌 청산 권고: {종목} ({ret}%)
  사유: {why}
  근거 브리핑: {briefDay}
  승인: 청산승인 {종목명}
  (미승인 시 오늘 20:00 만료)
```

`briefDay` 를 노출하는 것이 핵심이다. 오늘 사고에서 사용자가 "15:35 와 간밤이 안 맞는다" 를 즉시 잡아냈다. 사람에게 근거 일자를 보여주는 것만으로 이 결함이 잡힌다. 기계 신선도 게이트보다 확실하다 - 08-26 브리핑 자체가 08-24 재탕이었으므로 날짜 대조는 통과했을 수 있다.

`briefDay` 값의 출처: `morningBrief(today)` 가 읽은 `fc_report:pre:{dk}` 의 `dk`. 브리핑이 없으면 `null` 로 두고 "근거 브리핑: 없음" 으로 표기한다.

**승인 소비** (매 사이클)

```
.tg-requests.jsonl 을 state.tgReqCursor.lines(소비한 줄 수) 이후만 읽는다
  type 'ai_exit_approve' → aiExitPending 매칭 → 기존 가드를 전부 통과시킨 뒤
                           m.exitAt / m.exitDay / m.exitFrac=1 / m.exitQty / m.aiExit 를 심는다
                           (judgedDay · 기존 exitAt 중복 그대로 적용.
                            sellMaxPerDay 카운터는 **승인 시점에 소비**한다 - 제안은 무료,
                            실제 예약이 생길 때만 상한을 쓴다)
  type 'unquarantine'    → 저널 대조 후 분기:
                             botQty > 0  → removeBotExcludeAuto(code) + restoreMeta 적용
                                           "봇 규칙 재적용" 알림
                             botQty == 0 → **거부** + 설명 알림 (아래)
만료된 pending → 삭제 + 1회 알림
```

**커서는 ts 가 아니라 소비한 줄 수다.** append-only 파일이므로 줄 수가 안정적인 위치 지시자이고, 같은 초에 두 요청이 들어와도 중복 처리되지 않는다.

**`격리해제` 거부 케이스 (중요).** 봇이 산 적 없는 종목은 `격리해제` 를 **거부한다.** 적용할 검증된 규칙이 없기 때문이다. 검증된 청산 사다리는 `rsi2` / `hi120` 진입 신호에 묶여 있고(`judgeExitsAtClose:705` 가 그 둘만 판정한다), 임의의 `sub` 를 붙이면 그 포지션은 **폐지된 장중 손절·트레일 경로**(`:1174~1176`)로 떨어진다. 측정상 청산건당 -0.69%p 이고, `stock-live.mjs:1162~1168` 주석이 정확히 이 위험(사용자 평단과 무관한 meta 가 방금 생성돼 30초 안에 -15%/-6% 로 처분됨)을 이미 경고하고 있다.

```
거부 알림:
  ⚠️ {종목} 은 봇이 산 적이 없어 격리를 해제할 수 없습니다.
  적용할 검증된 청산 규칙이 없습니다(진입 신호를 봇이 만들지 않았습니다).
  이 종목은 매도사인 알림으로 직접 관리하시거나,
  매도 후 봇이 스스로 편입하게 두시면 됩니다.
```

이 결정으로 `sub:'adopted'` 라는 신규 개념이 사라진다. 새 상태를 만들지 않는 쪽이 맞다.

**telegram-agent** 는 `청산승인 <종목명>` 파서를 추가한다. 기존 `매도` / `격리해제` 와 같은 결정론적 파서(LLM 미사용, `resolveStock` 유일매칭, 모호하면 되물음)를 재사용하고, `.tg-requests.jsonl` 에 한 줄 append 한다.

**계약 플래그:** `AI_TRADER.sellRequiresApproval: true` 를 `strategy-contract.mjs` 에 추가한다. `false` 면 현행(자동집행)으로 롤백된다.

---

## 데이터 흐름

```
[매 사이클]
 토스 getHoldings
   → 원시보유
   → classifyPosition (저널 대조)
       ├ bot     → meta 유지/복원 → items 에 포함 → 검증된 청산 규칙
       ├ user    → .bot-exclude-auto.json → items 에서 제외 → emitSellSignals 만
       └ unknown → 조치 없음 + 경보
   → items 확정
   → 청산 판정: 예약청산(exitQty 상한) → rsi2/hi120 무개입 → sub미상 경보 → 손절/트레일
   → AI 판단: sellOk(sub·hold_days) 통과분만 → aiExitPending 등록 + 텔레그램 권고
   → .tg-requests.jsonl 소비: 승인 → m.exitAt 심기
                              격리해제 → 저널에 봇 BUY 있으면 복원, 없으면 거부+설명

[사용자]
 텔레그램 "청산승인 한화오션" → telegram-agent 결정론 파서 → .tg-requests.jsonl append
 텔레그램 "격리해제 한전기술" → telegram-agent 가 수동 파일에서 제거(자기 파일)
                              + .tg-requests.jsonl append (자동 파일은 stock-live 가 처리)
```

---

## 에러 처리 - 실패 방향

| 실패 | 방향 | 근거 |
|---|---|---|
| 저널 파싱 실패 | **판정 보류**(격리도 복원도 안 함) + 경보 | 격리 쪽으로 실패하면 봇 포지션의 검증된 -15% 손절이 사라진다. 기존 동작(sub 미상 = 자동청산 보류)이 이미 사용자 포지션을 지키고, AI 는 (3)(4)가 막는다 |
| `.bot-exclude-auto.json` 쓰기 실패 | 경보 + 다음 사이클 재시도 | 격리 실패해도 (4)가 AI 매도를 막으므로 즉시 위험 없음 |
| `.tg-requests.jsonl` 라인 파싱 실패 | 그 라인만 스킵 + 경보, 커서는 전진 | 깨진 한 줄이 승인 채널 전체를 막으면 안 된다 |
| `.tg-requests.jsonl` 부재 | 정상(요청 0건) | 최초 기동 시 정상 상태다 |
| 종목명 모호 | telegram-agent 가 되물음 | 기존 `resolveStock` 규칙 |

`.no-buy` 스위치는 fail-open 이다(고장이 매매정지로 번지면 안 된다). **이 패치들은 반대로 fail-safe 다** - 청산 가드의 고장은 오매도로 번지면 안 된다. 방향이 반대라는 점을 명시한다.

---

## 테스트

| 파일 | 케이스 |
|---|---|
| `tests/position-ownership.test.mjs` (신규) | 오늘 실측 3건: 295310 botQty=0 → user / 052690 botQty=0 → user / 042660 한화오션 botQty=34 → bot+restoreMeta · `meta.sub` 있으면 판정 스킵 · botQty < brokerQty(추가매수) → user · trades 빈 배열 → user · trades 가 배열 아님 → unknown · SELL > BUY 이상 데이터 → user · restoreMeta.hi ≥ entry 보장 |
| `tests/exit-qty-cap.test.mjs` (신규) | 오늘 시나리오 정확 재현(cap 326 → 147 체결 → cap 179 → brokerQty 322 → sellQty 179) · frac 0.5 부분익절과의 상호작용 · `exitQty` 미설정 시 현행 동작 폴백 · **cap 소진(0) 상태에서 사용자가 재매수했을 때 sellQty 가 1 이 아니라 예약 해제가 되는지** |
| `tests/strategy-contract.test.js` (확장) | **`m.exitAt =` 대입이 있는 모든 줄에 `exitQty` 가 같이 있는지 소스 대조**(새 예약 경로가 생겨도 잡힌다) · `sellRequiresApproval` 기본값 true |
| `ai-trader-bounds.test.mjs` (확장) | sellOk 가 `sub:null` · `hold_days:null` · `hold_days:0` 을 거부하는지 · 정상 케이스는 통과하는지(검출력 유지) |
| `tests/tg-requests.test.mjs` (신규) | 커서가 소비한 줄 수만큼만 전진하는지 · 같은 초에 들어온 두 요청이 각각 1회씩 처리되는지 · 깨진 라인 1줄이 뒤 라인 처리를 막지 않는지 · `unquarantine` 이 botQty 0 에서 거부되고 botQty>0 에서 복원되는지 |

**검출력 유지 확인:** 각 신규 테스트에 negative 케이스뿐 아니라 **통과해야 하는 케이스**를 함께 둔다. 오탐 수정이 검출력을 죽이는 것을 막기 위함이다(2026-08-22 캡처 판정기에서 같은 실수를 했다).

세 번째 항목이 이번 사고의 교훈을 직접 담는다. 가드가 일부 경로에만 있던 것이 원인이었으므로, 경로가 늘어날 때 기계가 잡게 한다.

---

## 배포 · 검증 · 롤백

**현재 상태:** `stock-live.service` = inactive(2026-08-26 09:54 사용자 승인 정지). `enabled` 는 유지되어 VM 재부팅 시 자동 기동된다.

**검증 순서** (전부 통과해야 재개)

1. `node --test "tests/**/*.test.{js,mjs}"` 전체 green
2. `node stock-live.mjs --plan` 드라이런 - 실주문 없이 분류 결과 확인. 052690 이 `user`, 저널에 BUY 가 있는 종목이 `bot` + 복원으로 **로그에** 찍히는지
3. scp → `vm.sh restart` → journalctl 에서 `자동 격리` / `meta 복원` 실제 발화 확인
4. 그 다음에 `systemctl start stock-live`

**롤백** (패치별 독립)

- (1): `.bot-exclude-auto.json` 삭제
- (2): `m.exitQty` 는 `?? qty` 폴백이라 값이 없으면 현행 동작
- (3): 추가한 두 조건 제거
- (4): `AI_TRADER.sellRequiresApproval: false`

---

## 미결

D1~D7 은 사용자 확정이다(2026-08-26 대화).

**D8 은 스펙 셀프리뷰에서 도출한 것으로 사용자 확인이 필요하다.** 초안은 `격리해제` 시 `sub:'adopted'` meta 를 만들어 봇에 넘기는 것이었으나, 셀프리뷰에서 그 경로가 폐지된 장중 청산 경로로 떨어진다는 것을 발견해 "거부 + 설명" 으로 바꿨다. 사용자가 "내가 산 것도 봇 규칙으로 관리받고 싶다" 를 원한다면 이 결정을 뒤집어야 하고, 그때는 수동 포지션용 청산 규칙을 별도로 검증해야 한다(현재 스펙 범위 밖).

그 외 미결 항목은 없다.
