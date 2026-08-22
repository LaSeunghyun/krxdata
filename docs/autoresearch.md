# autoresearch — 기록과 인계

- 작성 2026-08-22
- 상태: **안전장치 구현 완료 · 노이즈 바닥 pin 완료 · 1라운드 가동 완료(발견 0건)**
- 관련 문서: [설계](superpowers/specs/2026-08-21-autoresearch-loop-design.md) · [구현계획](superpowers/plans/2026-08-21-autoresearch-loop.md) · [루프 규약](../autoresearch.md)

이 문서는 "무엇을 만들었고, 왜 그렇게 만들었고, 어떻게 돌리고, 무엇을 배웠는가"를 한 장으로 남긴다.
새 세션에서 이 축을 재개할 때 이 파일부터 읽으면 된다.

---

## 1. 무엇에서 시작했나

`karpathy/autoresearch`(MIT, 2026-03, 스타 9만+). AI 에이전트에게 LLM 학습 코드를 주고
자율 실험을 맡기는 레포다. 파일 3개가 전부다.

| 파일 | 역할 |
|------|------|
| `prepare.py` | 고정 상수·데이터·평가함수. 에이전트 수정 금지 |
| `train.py` | 에이전트가 유일하게 수정하는 파일 |
| `program.md` | 사람이 작성하는 루프 규약 |

루프: 고정 5분 예산 → 단일 지표(`val_bpb`)로 keep/discard → git commit 단위로 브랜치 advance,
악화 시 `git reset` → `results.tsv`에 기록 → **NEVER STOP**.
지능은 레포 밖의 코딩 에이전트가 담당하고 레포 자체에는 LLM 호출 코드가 없다.

**이식한 것은 코드가 아니라 이 루프 구조다.**

---

## 2. 그대로 이식하지 않은 것과 그 이유

| 원본 | 우리 | 이유 |
|------|------|------|
| 단일 지표로 in-sample keep | ΔCalmar + 노이즈 바닥 + IS/OOS | `val_bpb`는 정지적이라 반복 평가가 안전하다. 백테 수익률은 아니다. 이 저장소 튜닝 전적이 **3승 46패**인데, 자동 루프는 시행 횟수만 늘려 거짓 keep을 양산한다 |
| `NEVER STOP` | 세션당 유한 루프(기본 6회) | 원본은 GPU 시간이 비용이고 사람이 자는 동안 돈다. 이쪽은 LLM 토큰이 비용이고 아이디어 고갈이 빠르다 |
| VM 무인 실행 | 세션 내 반복 | 무인 상태에서 게이트가 오작동하면 발견이 늦어진다 |
| `train.py` 자유 편집 | 조건부 — 교차오염 게이트 필수 | 아래 §3 |

---

## 3. 최대 위험: `combo-v2`는 독립 파일이 아니다

`train.py`는 자체 완결이라 망가지면 그 실험만 crash로 끝난다. 우리 쪽은 다르다.

`combo-v2`는 `backtest-swing.mjs`(128KB)의 공유 시뮬레이션 루프 안에서
**`k === 'combo' || k === 'combo-v2'` 분기를 레거시 `combo`와 함께 쓴다**(1057·1067·1224·1848·1857행).
두 전략은 `cfg.v2`와 파라미터로만 갈린다.

→ 에이전트가 `combo-v2`를 고치다 `combo`·`rsi2`·`hi120`·`gapfollow` 수치를 **조용히** 바꿀 수 있다.

**대응**: 매 실험에서 게이트 전략을 함께 돌려 baseline과 대조. 하나라도 움직이면 `contaminated`.
비용은 실측 ×1.6(3.0초 → 4.9초)이고, `combo`를 **카나리아**로 포함시킨다.

---

## 4. 만든 것

전부 `C:\claudeT\files`. 순수 로직은 테스트 가능한 모듈로, spawn·IO는 얇은 CLI로 분리했다.

| 파일 | 역할 |
|------|------|
| `validation-lib.mjs` | `median`·`mergeArgs`·`parseComboRow`·`calmar`·`mcMedian`. `validate-hypotheses.mjs`와 공유 |
| `autoresearch-gate.mjs` | 지문 + 배선검증/교차오염 판정 |
| `autoresearch-log.mjs` | 로그 포맷 · 기각축 매칭 · `verifySession`(설계 §10 4기준) |
| `autoresearch-run.mjs` | CLI `--init`/`--gate`/`--probe`/`--verify` |
| `mc-noise-floor.mjs` | 노이즈 바닥 전용 측정기 |
| `rejected-axes.tsv` | 기각축 20개 기계 대조(메모리 산문을 TSV로) |
| `autoresearch-floor.json` | 바닥 pin. **`20230102_20260724.calmar30 = 0.502`** |
| `autoresearch.md` | 루프 규약(`program.md` 대응) |

테스트 34개 추가. 실행 산출물(`autoresearch-base.json`·`-probe.json`·`-log.tsv`)은 gitignore.

### 게이트 2종 — 한 번의 결정론 실행으로 둘 다 판정

| status | 뜻 | 조치 |
|--------|-----|------|
| `ok` | 대상만 변했다 | MC 판정으로 |
| `not-wired` | 대상이 **안** 변했다 | **discard 아님.** 배선 결함이거나 파라미터 무감도 |
| `contaminated` | 게이트 전략이 변했다 | 되돌리고 `cfg.v2` 가드 확인 |
| `missing` | 게이트 전략이 덤프에 없다 | 판정 안 함 |

### 왜 `not-wired`를 `discard`와 구분하는가

non-live-parity 분기에 코드를 넣으면 `--live-parity` 실행에서 수치가 **완전히 동일**하게 나온다
(전례: `backtest-swing.mjs:1551` ROTATE 죽은 코드, `--caps A ≡ --caps G`).
이를 `discard`로 기록하면 **시도조차 못 한 축이 기각축 표에 영구 등재돼 이후 탐색을 오염시킨다.**
자동 루프에서는 이 오진이 사람 실험보다 빠르게 쌓인다.

---

## 5. 노이즈 바닥 = 0.502

`20230102~20260724`(폭락 포함) · 30시드 · 라이브 계약 + 갭정책 · 정제본.
원본 Calmar **1.931**(CAGR 52.52% / MDD 27.20%).

재현: `node mc-noise-floor.mjs --seeds 30 --perts 9 --conc 2`

### ★ 3벌 프로토콜은 추정량이 불안정하다 — 이번 측정의 핵심 발견

교란본 집합만 바꿔 독립 복제한 결과:

| 복제 | 교란본 | 바닥 |
|------|--------|------|
| R1 | 1-3 | 0.158 |
| R2 | 4-6 | 0.193 |
| R3 | 7-9 | **0.369** |
| 풀링 | 1-9 (10 arm) | **0.502** |

**2.3배 갈린다.** 첫 실행이 낸 0.158을 그대로 pin했다면 문턱이 3배 관대해져 거짓 keep을 허용했다.

- **`backtest-swing`은 (파일, 시드) 결정론이라 같은 교란본 재실행은 복제가 아니다.** 값이 글자 그대로 같다.
  `orig` arm이 3회 전부 1.931로 나온 것이 그 증거다.
- **`max-min`은 표본수에 따라 커지는 통계량**이라 arm 수를 고정해야 비교 가능하다. 과거 기록(0.268·0.486)은 3벌 기준.
- 풀링을 택한 근거: arm이 많을수록 실제 범위에 가깝고, **손실이 비대칭**이다 —
  문턱이 낮으면 노이즈를 신호로 채택(비싼 오류), 높으면 기회 상실(싼 오류). SD 0.149, range ≈ 3.4σ.
- **교차검증 2건**: ① 방법론 §1-B가 같은 구간에 기록한 **0.486**과 근접(당시 설정 Calmar 1.02 vs 현재 1.931인데도)
  ② Δ0.44 차단이 "손절 15%가 30시드 미통과(Δ+0.44 < 0.486)" 기록을 재현.

---

## 6. 첫 가동 (2026-08-22, `autoresearch/aug22`, 1라운드)

### R1 — 쿨다운(손절 후 재진입 금지) → `inconclusive`

축 선정 근거: 방법론의 비대칭(통과 3축이 전부 "거래를 줄이는" 방향) + 기각목록에 없음 +
`backtest-swing.mjs:1500` 주석의 "백테판을 이제 검증한다"가 미완 + **라이브는 이미 "당일 재진입 금지" 배포**.

| 단계 | 결과 |
|------|------|
| 게이트 | `ok` — combo-v2 18,841,447 → 19,482,015, 게이트 4개 불변 |
| 항등 대조군 | `--cooldown 0`이 변경 전 18,841,447을 **소수점까지 재현**(배선 정상) |
| 6시드 MC | ΔCalmar **+0.079**(cd3) / +0.083(cd5) / -0.009(cd1) |
| 판정 | 바닥 0.502의 **1/6** → `inconclusive`. 30시드 승격 안 함 |
| 조치 | 코드 되돌림. `--verify` PASS |

**부수 관찰**: 체결수가 전 arm 1040으로 동일하다. 쿨다운이 막은 자리를 다음 후보가 즉시 채운다
→ 이 축은 "거래를 줄이는" 방향이 아니라 **"종목을 바꾸는" 방향**이었다(46패 쪽 부류).
축을 고를 때 **슬롯이 항상 차는 구조인지 먼저 확인**해야 한다.

### 루프가 스스로 드러낸 설계 구멍 — `inconclusive` 신설

바닥 미달을 적을 칸이 없었다(`keep`/`discard`/`not-wired`/`contaminated`/`crash`).
방법론 §1은 "판정 불가 — 채택도 기각도 하지 않는다"로 규정하는데, `discard`로 적었다면
바닥에 묻힌 축이 "기각됨"으로 표에 올라가 영구히 재탐색이 막혔을 것이다. `not-wired`와 같은 오염 경로다.

→ `inconclusive` 추가 + `MERGEABLE_TO_REJECTED = ['discard']`로 병합 허용을 기계 고정.

---

## 7. 사고 기록 (반복 방지)

### 첫 가동에서 저지른 실수 2건

1. **`git reset --hard HEAD~1`이 미커밋 작업을 함께 날렸다.** 실험 커밋만 되돌린다고 생각했는데
   라운드 도중 만든 도구·규약 수정이 전부 사라졌다.
   → **라운드 산출물(도구·문서)은 되돌릴 실험 커밋과 분리해 먼저 커밋한다.**
2. **이미 있는 `mc-cooldown.mjs`(2026-07-29, cooldown 10/15 IS/OOS)를 모르고 같은 축을 골랐고
   Read 없이 덮어썼다**(reset이 우연히 복구).
   → **축 선정 전에 기존 `mc-*.mjs` 파일명을 훑는다.**

### 설계 단계에서 뒤집힌 전제

초안은 "기존 하네스가 `val_bpb`보다 엄격하다(MC·노이즈바닥·IS/OOS 갖춤)"를 전제했으나 **틀렸다.**
`validate-hypotheses.mjs`가 실제로 가진 것은 MC(기본 6시드) + medianFinal뿐이고,
노이즈바닥·IS/OOS·항등대조군은 일회성 `mc-*.mjs`와 사람의 절차에 있었다.
그대로 구현했다면 금지된 판정기가 자율 루프 속도로 도는 오버피팅 생성기가 됐다.

### 영향 범위를 과장했다가 정정

"VM 일일 크론이 4주간 라이브와 다른 전략을 재검증했다"고 보고했으나 **틀렸다.**
크론은 `--data-only`라 백테 가설을 통째로 건너뛰고 데이터가설 3건만 돈다.
낡은 base는 수동 full 실행에서만 드러나는 휴면 결함이었다.
→ **크론의 실제 인자를 확인하기 전에 영향 범위를 단정하지 말 것.** 코드에 옵션이 있다고 켜져 있는 건 아니다.

---

## 8. 곁가지로 해결된 것들

루프를 만들다 드러난 것들이라 함께 기록한다.

| 건 | 내용 |
|----|------|
| 미커밋 844줄 | 13파일(실매매 봇 포함)이 VM에 배포됐는데 git에 없었다. 3개 주제로 커밋 |
| `LIVE_PARITY_BASE` 드리프트 | 2026-07-22에 멈춰 있었다. **계약에서 파생**하도록 바꾸고 테스트 11건으로 고정 |
| `myVerdict` 3건 모순 | `slots s3`(실제5)·`partialtp tp_4_8`(실제6/12)·`rsivol on`(실제off). 어긋나면 FLIP 경보가 상시 울려 진짜 뒤집힘을 가린다 |
| `__DROP:` 토큰 | base가 라이브를 담자 presence 플래그를 끄는 arm을 표현할 수 없어졌다. `winner_stack`의 `baseline:[]`이 base의 `--skipneutralrsi`를 상속받아 두 arm이 접혔다 |
| `research-metrics.mjs` 미배포 | VM에 아예 없었다. `evalBarbell`이 동적 import하는데 `try/catch` 안이라 조용히 넘어갔을 것 |
| 실행 안 되던 테스트 5건 | `npm test` glob이 `*.test.js`라 `tg-order-record.test.mjs`를 건너뛰었다. **green인데 커버가 없는 상태** |
| CI/CD | GitHub Actions(테스트, 시크릿 없음) + `vm-deploy.mjs`(import 폐쇄 검사) |

---

## 9. 지금 상태에서 루프를 돌리려면

```bash
# 세션 시작
git status                                   # 미커밋 확인
git checkout -b autoresearch/<tag>
node autoresearch-run.mjs --init             # base 지문 (~6초)
node autoresearch-run.mjs --probe            # 센서 생존 증명 — 발화 안 하면 시작하지 않는다

# 매 라운드
#  1) rejected-axes.tsv + autoresearch-log.tsv + 기존 mc-*.mjs 파일명 확인
#  2) backtest-swing.mjs 수정 (공유 분기는 cfg.v2 가드 필수)
#  3) git commit
node autoresearch-run.mjs --gate             # ok / not-wired / contaminated / missing
#  4) ok 면 MC 판정 (수동, 기존 mc-*.mjs). 항등 대조군 필수
#  5) autoresearch-log.tsv 에 한 줄
#  6) keep 아니면 git reset --hard HEAD~1  ← 미커밋 작업 없는지 먼저 확인

# 세션 종료
node autoresearch-run.mjs --verify
```

규약 원본은 [`autoresearch.md`](../autoresearch.md)다. 이 문서와 어긋나면 그쪽이 맞다.

---

## 10. 남은 것

- **MC 판정 자동화 미포함**(의도적). 라운드 7단계는 수동 `mc-*.mjs`
- **자본 불일치**: 바닥 0.502는 `mc-*` 관행인 10,000,000에서 쟀는데 `LIVE_PARITY_BASE`는 실계좌 6,000,000이다.
  비율지표라 거의 같지만 정수주 사이징에서 갈릴 수 있다 → **ΔCalmar는 바닥과 같은 자본에서 잰다**
- 오염 프로브는 지문 수준 합성 교란. 실제 코드 변형 프로브는 미구현
- `git worktree` base 재확인 경로 미구현(캔들 캐시가 git 미추적이라 worktree에 데이터가 없다)
- 다른 전략으로 확장할 시 `backtest-swing.mjs` 전략별 분리 리팩토링 필요성 재판단(현재는 게이트로 대체)

---

## 11. 이 루프의 성공 판정

발견 건수로 재지 않는다. `--verify`가 세션 종료 시 4개를 assert한다.

1. 기각축 재제안 0
2. 교차오염 통과 0 (+ 프로브 발화 기록)
3. 바닥 미달·시드 미충원 `keep` 0 (바닥 수치와 직접 대조)
4. `main` 불변

**발견 0건이어도 위 4개가 지켜지면 루프는 정상 동작한 것이다.**
3승 46패 영역에서 6회 루프의 기대 발견 수는 1건 미만이다.
1라운드 실적: 발견 0건, `--verify` PASS, 설계 구멍 1건 발견·수정.
