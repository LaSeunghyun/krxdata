# combo-v2 Autoresearch 루프 설계

- 날짜: 2026-08-21
- 대상 저장소: `C:\claudeT\files`
- 상태: 설계 승인 + fable 검수 반영 후 문서화 (구현 미착수)
- 적용 범위: 로컬 실험 브랜치에서의 자율 탐색 루프
- 제외 범위: `main` 병합, VM 배포, `stock-live.service` 재시작, 실계좌 파라미터 변경, `validation-registry.mjs` 자동 등록

## 1. 배경

`karpathy/autoresearch`(MIT, 2026-03)는 에이전트에게 LLM 학습 코드를 주고 자율 실험을 맡기는 구조다. 파일 3개가 전부다.

| 파일 | 역할 |
|------|------|
| `prepare.py` | 고정 상수·데이터·평가함수(`evaluate_bpb`). 에이전트 수정 금지 |
| `train.py` | 에이전트가 유일하게 수정하는 파일 |
| `program.md` | 사람이 작성하는 루프 규약 |

루프 규약의 핵심은 다음과 같다. 고정 5분 시간예산으로 실험 간 비교가능성을 확보하고, 단일 스칼라 지표(`val_bpb`)로만 keep/discard를 판정하며, git commit 단위로 개선 시 브랜치를 advance하고 악화 시 `git reset`한다. 결과는 `results.tsv`에 남긴다. 지능은 레포 밖의 코딩 에이전트가 담당하고 레포 자체에는 LLM 호출 코드가 없다.

이 저장소에 이식할 가치가 있는 것은 코드가 아니라 이 루프 구조다.

## 2. 이 저장소의 현재 상태 (실측 기준)

관련 자산이 두 개 있다.

- `evolve-c0~c33` (2026-06-12~13): baseline `combo-v2` 대비 33개 후보를 train/valid 분리로 수동 테스트한 이력.
- `validate-hypotheses.mjs` + `validation-registry.mjs` (2026-07-22~, VM 일일 크론): 등록된 가설을 매일 재검증하고 판정이 뒤집히면 텔레그램 경보.

**단, 이 하네스가 제공하는 규율의 범위를 정확히 알아야 한다.** 코드 실측 결과는 다음과 같다.

| 규율 | `validate-hypotheses.mjs` 실제 |
|------|------|
| MC subsample × seeds | 있음. 기본 **6시드** |
| medianFinal 승자 판정 | 있음 |
| 노이즈 바닥 미달 시 판정 불가 | **없음.** 바닥 개념 자체가 없다 |
| IS/OOS 분리 | **없음.** 단일 구간 |
| 폭락 포함 구간 | **정반대.** `LIVE_PARITY_BASE`가 `--to 20260611` 고정 |
| 항등 대조군 | **없음** |

즉 노이즈 바닥·IS/OOS·항등 대조군·폭락 포함은 하네스가 아니라 일회성 `mc-*.mjs` 스크립트와 사람의 절차에 있다. `--to 20260611`은 `project_krxdata_validation_method.md` §1-B가 "가장 큰 함정"으로 지목한 폭락 제외 구간이다.

**이 문서의 설계는 그 공백을 루프가 스스로 메운다는 전제 위에 있다.** 하네스를 그대로 쓰면 "6시드 medianFinal + 폭락 제외 구간"이라는 금지된 판정기가 자율 루프의 속도로 돌아간다. 튜닝 전적 3승 46패 영역에서 그것은 오버피팅 생성기다.

## 3. 판정 체계

### 3-A. 하네스 재사용의 실제 범위

`validate-hypotheses.mjs`는 라이브러리로 재사용할 수 없다. top-level IIFE로 import 즉시 전체가 실행되고 export가 없다. 또한 휴장일이면 `exit 0`으로 즉시 종료하므로, 직접 spawn하면 주말·야간에 아무것도 돌지 않은 채 성공처럼 보인다.

따라서 다음과 같이 한다.

1. `mergeArgs` · `parseComboRow` · `mcMedianFinal`을 **`validation-lib.mjs`로 추출**한다.
2. `validate-hypotheses.mjs`와 신규 autoresearch 러너가 이 lib를 공유한다. 기존 크론 동작은 바뀌지 않는다.
3. 루프는 레지스트리를 거치지 않고 lib를 직접 호출한다.

새 판정 논리를 발명하지 않는다는 원칙은 유지하되, 러너는 신설한다.

### 3-B. 코드 변경의 baseline 확보

하네스의 variant는 **CLI 인자 차이**만 표현할 수 있고, 실행은 항상 현재 워킹트리의 `backtest-swing.mjs`를 spawn한다. 코드를 수정하면 baseline과 candidate가 **둘 다 수정된 코드로** 돌아 코드 변경 효과를 측정할 수 없다.

`backtest-swing.mjs`는 고정 seed에서 결정론적이다(동일 인자·동일 seed에서 combo-v2 행 완전일치 실측). 따라서 **브랜치 시작 시 base commit의 측정치를 1회 캐시**하고 이후 라운드는 그 캐시와 비교한다. 캐시가 의심되면 `git worktree`로 base 코드를 병행 실행해 재확인한다.

### 3-C. 판정 규율

- **지표**: ΔCalmar를 주지표로 하고 medianFinal을 병기한다. 노이즈 바닥이 ΔCalmar 단위로 정의되어 있기 때문이다.
- **구간**: `LIVE_PARITY_BASE` 앞에 `--to <최신>`을 prepend해 폭락을 포함시킨다. base의 `20260611`을 그대로 쓰지 않는다.
- **시드 2단계**: 6시드로 스크린하고, 통과 후보만 30시드로 확정한다. 6시드 단독으로는 바닥(10시드 0.527)보다 넓어 아무것도 판정하지 못한다.
- **노이즈 바닥**: 구간·시드수마다 다르므로 실행 구간에 맞춰 사전 핀하거나 `perturb-candles.mjs`로 재측정한다. 바닥 미달은 keep도 discard도 아니다.
- **IS/OOS**: IS `20230102~20241231` / OOS `20250102~최신`. 한쪽만 통과하면 keep하지 않는다.
- **시드 충원 확인**: `mcMedianFinal`은 실패 시드를 조용히 건너뛰고 n에 무관하게 승자를 뽑는다. 판정 전 `n == SEEDS`를 확인한다.
- **MC 중 병렬 작업 금지**: 같은 노드에서 다른 실험·무거운 스크립트를 겹치지 않는다. 겹치면 arm이 0시드로 죽고 바닥이 쓰레기값이 된다.

### 3-D. `NEVER STOP`을 채택하지 않는 이유

카파시 쪽은 GPU 시간이 비용이고 사람이 자는 동안 돌린다. 이쪽은 LLM 토큰이 비용이고 아이디어 고갈이 빠르다. 세션당 유한 루프(기본 6회)로 돌고 요약 보고 후 정지한다.

## 4. 교차오염 게이트

### 4-A. 문제

`combo-v2`는 독립 함수가 아니다. `backtest-swing.mjs`(128KB)의 공유 시뮬레이션 루프 안에서 **`k === 'combo' || k === 'combo-v2'` 분기를 레거시 `combo`와 함께 쓴다**(1057·1067·1224·1848·1857행). 두 전략은 `cfg.v2`와 파라미터로만 갈린다.

`train.py`는 자체 완결이라 망가지면 그 실험만 crash로 끝난다. 여기서는 에이전트가 `combo-v2`를 고치다 `combo`·`rsi2`·`hi120`·`gapfollow`의 수치를 조용히 바꿀 수 있다.

### 4-B. 실현 가능성 (실측)

전략들은 `--strategies`로 따로 돌릴 필요가 없다. 한 번의 실행에서 `ACTIVE` 전략 전체가 동일 데이터 위에서 시뮬레이션된다. 비용도 싸다.

| 실행 | 시간 |
|------|------|
| combo-v2 단독 | 3.0초 |
| combo-v2 + combo + rsi2 + hi120 + gapfollow | 4.9초 (×1.6) |

subsample RNG는 전략 실행 전 종목 집합에만 적용되므로 전략 수가 combo-v2 결과에 영향을 주지 않는다(두 실행에서 combo-v2 행 완전일치 실측).

### 4-C. 게이트 규약

- **게이트 세트**: `{combo, rsi2, hi120, gapfollow}`. `swing-rank`는 `daily_rankings` DB 쿼리를 추가로 발생시키므로 제외한다.
- **`combo`를 포함한다.** 공유 분기의 카나리아 역할을 하기 때문이다. 대신 **공유 분기를 수정할 때는 반드시 `cfg.v2` 또는 `k === 'combo-v2'` 가드를 둔다.** 가드 없는 수정은 정당한 실험이어도 `combo`를 바꾸므로 `contaminated`가 된다.
- **비교 방식**: 고정 seed 결정론 런 1회, `--dump` JSON의 최종자본·체결수 완전일치 비교. **stdout 행 파싱을 쓰지 않는다.** 에이전트가 출력 포맷을 건드리면 조용히 무너진다.
- **`--strategies` 오버라이드는 prepend한다.** `LIVE_PARITY_BASE`에 이미 `--strategies combo-v2`가 있고 `argOf`는 첫 출현만 읽는다. 뒤에 붙이면 게이트 지정이 무시된다.
- **세션 시작 시 오염 프로브 self-test**: 공유 상수 하나를 고의로 바꿔 게이트가 실제로 발화하는지 확인한다. 한 번도 울리지 않는 게이트는 죽은 게이트와 구분할 수 없다.

## 5. 격리

- 작업은 `autoresearch/<tag>` 브랜치에서만 한다. `main`은 건드리지 않는다.
- 실험 브랜치를 자동 merge하지 않는다.
- VM 크론은 `main`만 보므로 실험 중 영향을 받지 않는다.
- 착수 전 `git status`로 미커밋 작업물을 확인하고 stash 또는 commit한다.
- MC 전 `.dbcache`를 워밍한다. `backtest-swing.mjs`는 Supabase 쿼리 3개를 쓰므로 워밍 없이는 MC 중 스냅샷 드리프트가 가능하다.

## 6. 루프 규약

`autoresearch.md`를 이 저장소에 신설한다. `program.md`에 대응하며 사람이 편집한다.

매 라운드는 다음 순서다.

1. git 상태 확인(현재 브랜치·커밋)
2. `rejected-axes.tsv`와 과거 실험 로그를 읽고 아직 시도하지 않은 변경 하나를 제안
3. `combo-v2` 관련 코드 또는 파라미터를 수정 (공유 분기는 `cfg.v2` 가드 의무)
4. git commit
5. 하네스 실행. 출력은 파일로 리다이렉트한다(컨텍스트 범람 방지)
6. **배선검증 (1런)**: combo-v2 수치가 base 캐시와 달라졌는지 확인한다. **동일하면 `not-wired`로 기록하고 종료한다.** discard가 아니다.
7. 교차오염 게이트 확인. 실패 시 `contaminated`로 discard
8. MC 판정. 6시드 스크린 → 통과 시 30시드 확정. 바닥·IS/OOS·시드충원 규율 적용
9. `autoresearch-log.tsv`에 기록
10. 개선 시 브랜치 advance, 그 외 `git reset`

step 6이 이 규약에서 가장 중요하다. 이유는 아래 §6-A에 있다.

### 6-A. `not-wired`를 discard와 구분하는 이유

에이전트가 non-live-parity 분기에 코드를 넣으면 `--live-parity` 실행에서 수치가 완전히 동일하게 나온다. 이 전례는 이 저장소에 이미 박제되어 있다 — `backtest-swing.mjs:1551` 주석: ROTATE가 non-live-parity 분기에만 걸려 있어 `--live-parity` 실행에서는 죽은 코드였다. `--caps A`와 `--caps G`가 완전히 동일하게 나온 사례도 같은 계열이다.

이때 루프가 "효과 없음 → discard"로 기록하면, §7대로 사람이 그것을 기각축 표에 병합하고, **시도조차 하지 않은 축이 영구 기각 목록에 들어가 이후 탐색을 오염시킨다.** 무인 반복 루프에서는 이 오진이 사람 실험보다 빠르게 쌓인다.

`argOf`가 첫 출현만 읽는 함정도 같은 증상으로 나타난다(base와 겹치는 플래그가 조용히 무시됨). 따라서 step 6은 배선 결함과 플래그 무시를 동시에 잡는 검출기다. **모든 override는 prepend한다.**

## 7. 로깅

`autoresearch-log.tsv` (탭 구분, git 미추적)

```
commit	axis_id	delta_calmar	median_final	noise_floor_pass	is_oos_agree	seeds_n	status	description
```

- `status`: `keep` / `discard` / `not-wired` / `contaminated` / `crash`
- `axis_id`: `rejected-axes.tsv`와 대조하기 위한 식별자

라운드 종료 후 사람이 검토해 `project_krxdata_validation_method.md`의 기각축 표에 병합한다. **`not-wired`는 절대 기각축으로 병합하지 않는다.** 자동 병합도 하지 않는다.

## 8. keep의 의미

`keep`은 실험 브랜치 안에서의 유효 발견을 뜻한다. 그 이상이 아니다.

- `keep` → `validation-registry.mjs`에 **후보로만** 제안. 등록 자체도 사람이 한다.
- 실계좌·`main` 반영은 항상 사람이 최종 확인 후 수동으로 한다.

루프가 레지스트리를 거치지 않고 lib를 직접 호출하므로(§3-A) 이 원칙과 자율 탐색이 충돌하지 않는다. 자율성은 탐색에만 부여하고 반영에는 부여하지 않는다.

`validate-hypotheses.mjs`에 이미 명시된 "실계좌 파라미터는 절대 자동 변경 안 함 — 경보 → 사람 → 사람이 결정" 규칙을 그대로 승계한다.

## 9. 실행

세션 내 반복으로 돌린다. `/loop` 또는 Workflow의 loop-until-count 패턴을 쓴다. 사람이 비용과 중간 결과를 즉시 확인할 수 있다.

VM 무인 실행은 채택하지 않는다. 그 경로는 LLM 호출을 위한 별도 API 키·비용 구조가 필요하고, 무인 상태에서 게이트가 오작동하면 발견이 늦어진다.

## 10. 성공 판정

이 루프의 성공은 발견 건수로 재지 않는다. 아래 4개를 세션 종료 시 `autoresearch-verify.mjs`가 일괄 assert한다.

| 기준 | 기계 확인 방법 |
|------|------|
| 기각축 재제안 없음 | 로그의 `axis_id`를 `rejected-axes.tsv`와 대조 |
| 교차오염 통과 없음 | 게이트 발화 이력 + 세션 시작 오염 프로브 self-test 통과 기록 |
| 바닥 미달 keep 없음 | `status == keep` 행 전부에서 `delta_calmar > 바닥` 및 `seeds_n == 30` 확인 |
| main·실계좌 무변경 | 세션 시작 `git rev-parse main` 기록 → 종료 시 불변 assert, 실험 커밋이 main에 없음 확인 |

이를 위해 기각축을 `rejected-axes.tsv`(axis_id·키워드)로 기계화한다. 현재 기각축은 메모리 문서의 산문이라 대조할 수 없다.

**검증 스크립트가 없으면 §10은 선언에 그친다.** "발견 0건이어도 정상"과 "루프가 통째로 죽어 0건"을 구분할 수 없기 때문이다. 이 저장소는 그 함정을 이미 두 번 밟았다(`NOISE_PATTERNS` TDZ로 미매칭 로깅 100% 사망하고도 테스트 5건 전부 통과, 휴장일 `exit 0`).

발견이 0건이어도 위 4개가 지켜지면 루프는 정상 동작한 것이다. 튜닝 전적이 3승 46패인 영역에서 6회 루프의 기대 발견 수는 1건 미만이다.

## 11. 확장 여지 (미착수)

`backtest-swing.mjs`의 전략별 분리 리팩토링은 하지 않는다. 교차오염 게이트가 같은 문제를 더 적은 변경으로 막는다. 다른 전략에 이 루프를 적용할 시점에 다시 판단한다.
