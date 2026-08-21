# autoresearch — combo-v2 자율 탐색 규약

이 파일은 사람이 편집한다. 에이전트는 읽고 따른다.
설계 근거: `docs/superpowers/specs/2026-08-21-autoresearch-loop-design.md`

## 세션 시작 (한 번)

1. `git status` 로 미커밋 작업물을 확인하고 stash 또는 commit 한다.
2. 실험 브랜치를 만든다: `git checkout -b autoresearch/<tag>` (tag = 날짜, 예 `aug21`).
   같은 이름 브랜치가 이미 있으면 새 tag 를 쓴다.
3. `.dbcache` 를 워밍한다. `backtest-swing.mjs` 는 Supabase 쿼리 3개(956·963·967행)를 쓰고
   그 값은 **현재 스냅샷**이라, 캐시가 없으면 라운드마다 다른 유니버스를 보게 된다(방법론 §9).
   `--init` 이 첫 실행이므로 자동으로 채워지지만, 실패하면 여기서 멈추고 보고한다.
4. base 지문을 뜬다: `node autoresearch-run.mjs --init`
5. 오염 센서 생존을 증명한다: `node autoresearch-run.mjs --probe`
   발화하지 않으면 **루프를 시작하지 않는다.** 게이트가 죽은 상태다.
6. `rejected-axes.tsv` 를 읽는다.

## 매 라운드 (기본 6회)

1. `git log --oneline -3` 으로 현재 위치를 확인한다.
2. `rejected-axes.tsv` 와 `autoresearch-log.tsv` 를 읽고 **아직 시도하지 않은** 변경 하나를 정한다.
   기각축과 겹치면 다른 것을 고른다. 겹침 판정은 `--verify` 가 나중에 기계로 다시 본다.
3. `backtest-swing.mjs` 를 수정한다.
   - **공유 분기 규칙**: `k === 'combo' || k === 'combo-v2'` 블록을 고칠 때는 반드시
     `cfg.v2` 또는 `k === 'combo-v2'` 로 가드한다. 가드가 없으면 `combo` 가 같이 바뀌어
     교차오염으로 판정된다.
   - **플래그 규칙**: 새 플래그를 넣으면 `--live-parity` 경로에 배선한다.
     non-live-parity 분기에만 넣으면 죽은 코드가 된다(전례: `backtest-swing.mjs:1551`).
4. `git add -A && git commit -m "exp: <설명>"`
5. 게이트를 돌린다: `node autoresearch-run.mjs --gate`
   출력은 짧다. 백테스트 stdout 을 직접 읽지 않는다(컨텍스트 범람).
6. 게이트 결과에 따라 분기한다.
   - `not-wired` → **discard 가 아니다.** 로그에 `not-wired` 로 적고 `git reset --hard HEAD~1`.
     **기각축 표에 절대 병합하지 않는다.** 시도조차 못 한 축이다.
     원인은 두 가지다 — ① 배선 결함(non-live-parity 분기·flag prepend 누락)
     ② 파라미터 무감도(그 밴드에 걸리는 체결이 0건). 어느 쪽이든 "효과 없음"이 아니다.
   - `contaminated` → 로그에 `contaminated`, `git reset --hard HEAD~1`.
     `changedGate` 에 뜬 전략을 보고 가드 누락 지점을 고친 뒤 재시도할 수 있다.
   - `crash` → 로그에 `crash`. 오타·import 누락처럼 단순하면 고쳐 재시도, 아이디어 자체가
     깨진 것이면 넘어간다.
   - `missing` → 게이트 전략 중 일부가 덤프에 없다. 판정하지 않는다.
     `--strategies` 가 prepend 됐는지, 전략 이름을 오타 없이 썼는지 확인하고 고친 뒤 재실행한다.
     끝내 안 되면 **멈추고 보고한다** — 게이트 없이 라운드를 진행하지 않는다.
   - `ok` → 7번으로 간다.
7. MC 판정을 한다. **이 단계는 자동화되어 있지 않다** — 기존 `mc-*.mjs` 절차를 쓴다.
   - 6시드로 스크린한다. 개선 방향이 아니면 `discard`.
   - 스크린 통과 시 30시드로 확정한다. `n == 30` 인지 확인한다(죽은 시드가 있으면 판정 불가).
   - IS `20230102~20241231` / OOS `20250102~20260724` 양쪽을 본다. 한쪽만이면 `discard`.
   - ΔCalmar 가 `autoresearch-floor.json` 의 바닥을 넘는지 본다. 바닥이 `null` 이면
     **`keep` 을 낼 수 없다.** `discard` 하거나 바닥을 먼저 측정한다.
   - MC 실행 중 다른 무거운 작업을 겹치지 않는다(방법론 §1-F).
8. `autoresearch-log.tsv` 에 한 줄 추가한다. 열은 아래와 같다.
   `commit  axis_id  delta_calmar  median_final  noise_floor_pass  is_oos_agree  seeds_n  status  description`
9. `keep` 이면 브랜치를 그대로 두고 다음 라운드로. 그 외는 `git reset --hard HEAD~1`.

## 세션 종료

1. `node autoresearch-run.mjs --verify`
   `FAIL` 이면 무엇이 깨졌는지 보고한다. **통과하지 못한 세션의 결과는 보고하지 않는다.**
2. 사람에게 요약을 보고한다. 라운드별 status 와 `keep` 후보를 적는다.
3. **여기서 멈춘다.** 아래는 전부 사람의 일이다.
   - `rejected-axes.tsv` 에 새 기각축 추가
   - `validation-registry.mjs` 에 `keep` 후보 등록
   - `main` 병합·실계좌 반영

## 하지 않는 것

- `main` 을 건드리지 않는다. 자동 merge 하지 않는다.
- `prepare.py` 격의 고정 자산을 고치지 않는다: `research-metrics.mjs`,
  `research-backtest-output.mjs`, `strategy-contract.mjs`, `live-parity.mjs`.
  평가·계약 쪽을 고치면 지표 자체가 움직여 비교가 성립하지 않는다.
- `validation-registry.mjs` 를 자동 수정하지 않는다.
- `autoresearch-gate.mjs`·`autoresearch-log.mjs`·`autoresearch-run.mjs` 를 고치지 않는다.
  자기를 감시하는 게이트를 스스로 손대면 감시가 무의미해진다.
- 새 의존성을 추가하지 않는다.
- 발견을 만들려고 무리하지 않는다. 이 영역 튜닝 전적은 3승 46패이고
  6회 루프의 기대 발견 수는 1건 미만이다. **0건은 실패가 아니다.**
- 사람이 멈추기 전에 스스로 라운드 수를 늘리지 않는다(원본의 NEVER STOP 은 채택하지 않았다).
