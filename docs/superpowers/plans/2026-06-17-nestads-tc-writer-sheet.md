# NestAds TC Writer — 구글시트 기록 교체 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tc-writer` 워크플로우를 "채팅 마크다운 출력"에서 "구글시트 신규 템플릿 탭 기록"으로 교체한다.

**Architecture:** 순수 변환 로직(JSON→행 매트릭스)과 gspread I/O를 분리한 `write_tc.py`를 nestads-product 플러그인에 추가하고, `tc-writer.md`를 재작성해 생성→초안 게이트→스크립트 호출→시트 URL 보고 + 파이프라인 컨텍스트 마커 유지 흐름으로 바꾼다. OAuth는 사용자 본인 계정(쓰기 scope) 1회 재동의.

**Tech Stack:** Python 3.12, gspread 6.x, google-auth-oauthlib, Google Sheets API

---

## 확정된 상수 (probe로 검증됨)

- 스프레드시트 ID: `1IFYgvMJMVwJKYhkunUcDIh0JZQofyAfro2BT16qZky0`
- 신규 템플릿 탭 gid: `1348692452`
- 메타 셀: `B1`=제목, `D3`=Test 시작일, `D4`=Test 종료일, `D5`=TC 작성자, `D6`=테스트 진행자
- TC 헤더 행: 11 / 데이터 시작 행: **12**
- 데이터 칼럼: `B`=Case ID, `C`=Component, `D`=Category1, `E`=Category2, `F`=테스트 시나리오, `G`=사전 조건, `H`=테스트 단계, `I`=기대 결과, `J~O`=역할6(전체관리/운영관리/성과조회/최고관리자/재무/CS), `P`=BUG ID, `Q`=Comment
- 역할 기본값: `N/T`
- 집계 수식 범위: `COUNTIF(J12:L458, ...)` → 데이터 최대 458행까지 커버 (행 확장 불필요)

## 편집 대상 경로

- 소스 레포: `C:\claudeT\nestads-product`
- 활성 사본(런타임이 읽음):
  - `C:\Users\wisebirds\.claude\plugins\marketplaces\wisebirds-marketplace\plugins\nestads-product`
  - `C:\Users\wisebirds\.claude\plugins\cache\wisebirds-marketplace\nestads-product\1.0.0`
  - `C:\Users\wisebirds\.claude\plugins\cache\wb-local-test\nestads-product\1.0.0`

## File Structure

| 파일 | 책임 |
|------|------|
| `harness/scripts/write_tc.py` (신규) | JSON→시트 기록. 순수 변환부 + gspread I/O부 분리 |
| `harness/scripts/test_write_tc.py` (신규) | 순수 변환부 단위 테스트 (pytest 불필요, plain assert) |
| `harness/workflows/tc-writer.md` (재작성) | 워크플로우 지시문 — 출력 대상을 시트로 변경 |

---

### Task 1: write_tc.py 순수 변환 로직 (TDD)

**Files:**
- Create: `C:\claudeT\nestads-product\harness\scripts\write_tc.py`
- Test: `C:\claudeT\nestads-product\harness\scripts\test_write_tc.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`test_write_tc.py`:
```python
import write_tc as w


def test_build_rows_maps_columns_and_defaults_roles():
    cases = [{
        "id": "case-001", "component": "매체 어드민",
        "cat1": "UI 변경", "cat2": "필드명 변경",
        "scenario": "라벨 변경 확인", "precondition": "등록 화면 접근",
        "steps": "1. 진입\n2. 확인", "expected": "라벨이 바뀜",
    }]
    rows = w.build_rows(cases)
    assert len(rows) == 1
    r = rows[0]
    assert len(r) == 16  # B..Q
    assert r[0] == "case-001"
    assert r[1] == "매체 어드민"
    assert r[7] == "라벨이 바뀜"
    # J..O 역할 6칸 전부 N/T
    assert r[8:14] == ["N/T"] * 6
    assert r[14] == ""  # BUG ID
    assert r[15] == ""  # Comment


def test_build_rows_autonumbers_missing_id():
    rows = w.build_rows([{"scenario": "x"}, {"scenario": "y"}])
    assert rows[0][0] == "case-001"
    assert rows[1][0] == "case-002"


def test_build_meta_updates_targets_correct_cells():
    meta = {"title": "T", "start": "26/6/20", "end": "",
            "author": "라승현", "tester": ""}
    ups = dict(w.build_meta_updates(meta))
    assert ups["B1"] == "T"
    assert ups["D3"] == "26/6/20"
    assert ups["D4"] == ""
    assert ups["D5"] == "라승현"
    assert ups["D6"] == ""


def test_dedup_tab_name():
    assert w.dedup_tab_name("WP-1", {"WP-2"}) == "WP-1"
    assert w.dedup_tab_name("WP-1", {"WP-1"}) == "WP-1_2"
    assert w.dedup_tab_name("WP-1", {"WP-1", "WP-1_2"}) == "WP-1_3"


def _run():
    import traceback
    fns = [v for k, v in globals().items() if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(fns)-failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    _run()
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd /c/claudeT/nestads-product/harness/scripts && PYTHONUTF8=1 python test_write_tc.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'write_tc'` 또는 AttributeError

- [ ] **Step 3: 최소 구현 작성**

`write_tc.py`:
```python
#!/usr/bin/env python3
"""NestAds TC → 구글시트 신규 템플릿 탭 기록기.

사용법:
  python write_tc.py <input.json>

input.json 예시:
  {
    "spreadsheet_id": "1IFYg...",   # 생략 시 기본값
    "template_gid": 1348692452,      # 생략 시 기본값
    "tab_name": "WP-9201",
    "meta": {"title":"...","start":"26/6/20","end":"","author":"라승현","tester":""},
    "cases": [{"id":"case-001","component":"...","cat1":"...","cat2":"...",
               "scenario":"...","precondition":"...","steps":"...","expected":"...",
               "bug_id":"","comment":""}]
  }
"""
import json
import sys

DEFAULT_SPREADSHEET_ID = "1IFYgvMJMVwJKYhkunUcDIh0JZQofyAfro2BT16qZky0"
DEFAULT_TEMPLATE_GID = 1348692452
ROLE_DEFAULT = "N/T"
DATA_START_ROW = 12
DATA_END_ROW = 458  # 집계 수식 COUNTIF(J12:L458) 커버 범위
WRITE_SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def build_rows(cases):
    """cases(list[dict]) → B12:Q 매트릭스. 역할 6컬럼은 전부 N/T."""
    rows = []
    for i, c in enumerate(cases, start=1):
        cid = c.get("id") or f"case-{i:03d}"
        rows.append([
            cid,
            c.get("component", ""),
            c.get("cat1", ""),
            c.get("cat2", ""),
            c.get("scenario", ""),
            c.get("precondition", ""),
            c.get("steps", ""),
            c.get("expected", ""),
            ROLE_DEFAULT, ROLE_DEFAULT, ROLE_DEFAULT,  # J,K,L
            ROLE_DEFAULT, ROLE_DEFAULT, ROLE_DEFAULT,  # M,N,O
            c.get("bug_id", ""),
            c.get("comment", ""),
        ])
    return rows


def build_meta_updates(meta):
    """meta(dict) → [(a1, value)] 메타 셀 업데이트 목록."""
    return [
        ("B1", meta.get("title", "")),
        ("D3", meta.get("start", "")),
        ("D4", meta.get("end", "")),
        ("D5", meta.get("author", "")),
        ("D6", meta.get("tester", "")),
    ]


def dedup_tab_name(name, existing):
    """existing(set[str]) 중복 시 _2,_3.. suffix를 붙인다."""
    if name not in existing:
        return name
    n = 2
    while f"{name}_{n}" in existing:
        n += 1
    return f"{name}_{n}"
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd /c/claudeT/nestads-product/harness/scripts && PYTHONUTF8=1 python test_write_tc.py`
Expected: PASS — `4/4 passed`

- [ ] **Step 5: 커밋**

```bash
git -C /c/claudeT/nestads-product add harness/scripts/write_tc.py harness/scripts/test_write_tc.py
git -C /c/claudeT/nestads-product commit -m "feat(tc-writer): TC→시트 순수 변환 로직 + 테스트"
```

---

### Task 2: write_tc.py gspread I/O + 자격증명 안내

**Files:**
- Modify: `C:\claudeT\nestads-product\harness\scripts\write_tc.py` (append I/O 함수 + main)

- [ ] **Step 1: I/O 함수와 main 추가**

`write_tc.py` 끝에 추가:
```python
CREDENTIALS_HELP = """\
[설정 필요] OAuth 자격증명이 없습니다.

1) Google Cloud Console에서 '데스크톱 앱' OAuth 클라이언트 ID를 발급(JSON 다운로드)
   - API: Google Sheets API + Google Drive API 사용 설정
   - OAuth 동의 화면: 내부(Internal)
2) 받은 JSON을 아래 경로에 'credentials.json' 이름으로 저장:
   %APPDATA%\\gspread\\credentials.json
3) 본 스크립트를 다시 실행 → 브라우저에서 본인 Google 계정으로 로그인/허용
   (이후 토큰이 캐시되어 재로그인 불필요)
"""


def _open_client():
    """gspread 클라이언트 반환. 자격증명 없으면 안내 후 종료."""
    import gspread
    try:
        return gspread.oauth(scopes=WRITE_SCOPES)
    except FileNotFoundError:
        print(CREDENTIALS_HELP, file=sys.stderr)
        raise SystemExit(2)


def write_tc(payload, gc=None):
    """payload(dict)대로 새 탭 생성·기입. 새 탭 dict({name,gid,url}) 반환."""
    import gspread

    spreadsheet_id = payload.get("spreadsheet_id", DEFAULT_SPREADSHEET_ID)
    template_gid = int(payload.get("template_gid", DEFAULT_TEMPLATE_GID))
    tab_name_req = payload["tab_name"]
    meta = payload.get("meta", {})
    cases = payload.get("cases", [])

    if not cases:
        raise ValueError("cases 가 비어 있습니다 — 기록할 TC가 없습니다.")
    n = len(cases)
    if DATA_START_ROW + n - 1 > DATA_END_ROW:
        raise ValueError(
            f"TC {n}건이 템플릿 집계 범위(최대 "
            f"{DATA_END_ROW - DATA_START_ROW + 1}건)를 초과합니다."
        )

    gc = gc or _open_client()
    sh = gc.open_by_key(spreadsheet_id)

    existing = {ws.title for ws in sh.worksheets()}
    tab_name = dedup_tab_name(tab_name_req, existing)

    # 1) 신규 템플릿 탭 복제 (서식·집계 수식·그룹화 보존)
    new_ws = sh.duplicate_sheet(
        source_sheet_id=template_gid, new_sheet_name=tab_name
    )

    # 2) 예시행 클리어 (B12:Q458)
    new_ws.batch_clear([f"B{DATA_START_ROW}:Q{DATA_END_ROW}"])

    # 3) 메타 + TC 행 일괄 기입
    rows = build_rows(cases)
    updates = [{"range": a1, "values": [[v]]}
               for a1, v in build_meta_updates(meta)]
    updates.append({
        "range": f"B{DATA_START_ROW}:Q{DATA_START_ROW + n - 1}",
        "values": rows,
    })
    new_ws.batch_update(updates, value_input_option="USER_ENTERED")

    url = (f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}"
           f"/edit#gid={new_ws.id}")
    return {"name": tab_name, "gid": new_ws.id, "url": url,
            "renamed": tab_name != tab_name_req, "count": n}


def main():
    if len(sys.argv) != 2:
        print("usage: python write_tc.py <input.json>", file=sys.stderr)
        raise SystemExit(1)
    with open(sys.argv[1], encoding="utf-8") as f:
        payload = json.load(f)
    result = write_tc(payload)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: import 회귀 테스트 — 순수부 테스트 재실행**

Run: `cd /c/claudeT/nestads-product/harness/scripts && PYTHONUTF8=1 python test_write_tc.py`
Expected: PASS — `4/4 passed` (I/O 추가가 순수부를 깨지 않음)

- [ ] **Step 3: 자격증명 안내 경로 수동 확인 (선택)**

`gspread.oauth`가 `FileNotFoundError`를 던지면 `_open_client`가 `CREDENTIALS_HELP`를 출력하고 exit 2 하는지 코드 리뷰로 확인. (실제 트리거는 Task 4 재인증에서 자연 검증)

- [ ] **Step 4: 커밋**

```bash
git -C /c/claudeT/nestads-product add harness/scripts/write_tc.py
git -C /c/claudeT/nestads-product commit -m "feat(tc-writer): gspread 시트 기록 I/O + 자격증명 안내"
```

---

### Task 3: tc-writer.md 재작성

**Files:**
- Modify(전면 교체): `C:\claudeT\nestads-product\harness\workflows\tc-writer.md`

- [ ] **Step 1: 새 내용으로 전면 교체**

아래 전체로 파일을 덮어쓴다:
```markdown
---
id: tc-writer
name: NestAds TC 작성기
version: 2.0
updated: 2026-06-17
tags: [planning, test-case, qa, nestads, sheet]
complexity: medium
---

## 역할

유저스토리+여정 또는 Jira/Confluence/기획서 산출물을 기반으로 TC를 생성하고,
**구글 스프레드시트 '신규 템플릿'을 복제한 새 탭에 기록**한다.
독립 실행 또는 nestads-pipeline Phase 3으로 실행된다.

## 입력 모드

- **파이프라인 모드:** 컨텍스트에서 `## [Phase 2 완료] 유저스토리 + 여정` 헤더를 먼저 탐색해 입력으로 사용한다.
- **독립 실행 모드:** 티켓키/URL이 주어지면 아래를 취합한다.
  - Jira: `getJiraIssue`로 본문·수용기준·링크
  - Confluence: 연결된 기획 페이지 `getConfluencePage`
  - 기획서/Figma URL: 있으면 추가 참고
- 입력 산출물이 비어 있으면 **추측 생성 금지** — 사용자에게 소스를 요청하고 중단한다.

## 분류 체계 (시나리오 도출용 — 칼럼으로 출력하지 않음)

정상 / 엣지 / 에러 / 권한 4관점으로 시나리오를 빠짐없이 도출하되,
신규 템플릿에는 별도 분류·우선순위 칼럼이 없으므로 **시나리오 내용으로 흡수**한다.

## 자동 도출 기준

- 유저스토리 1개 → 정상 케이스 최소 1개
- 빈 상태(Empty State) → 목록형 화면이면 항상 포함
- 로딩/에러 Toast → API 있는 화면이면 항상 포함
- 운영 admin 전용 기능 → 권한 케이스 포함

## 출력 스키마 (신규 템플릿 칼럼)

| 칼럼 | 내용 |
|------|------|
| Case ID | `case-001`부터 순번 |
| Component | 매체 어드민 / 운영사 어드민 등 대상 |
| Category1 | 기능 영역 (예: UI 변경, 광고 선택 로직) |
| Category2 | 세부 유형 (예: 필드명 변경, Cold Start 방어) |
| 테스트 시나리오 | 검증 대상 한 줄 |
| 사전 조건 | 진입/전제 조건 |
| 테스트 단계 | 번호 매긴 단계 (생략 가능) |
| 기대 결과 | 검증 가능한 기대 동작 |
| 역할 6칸 | 전체관리/운영관리/성과조회/최고관리자/재무/CS — 전부 `N/T` |
| BUG ID, Comment | 공란 |

## 실행 절차

1. 입력 모드에 맞게 산출물 취합
2. 위 스키마로 TC 생성 (자동 도출 기준 준수)
3. **초안 게이트**: 생성 TC를 채팅에 표로 제시하고 아래로 확인받는다.
   > "이 TC를 '신규 템플릿' 새 탭으로 기록할까요? 탭 이름(예: WP-9201)과 추가/수정 사항을 알려주세요."
   - 거절 시: 지정 TC만 수정/추가 후 재제시
4. **승인 시 기록:**
   - 입력 JSON을 임시 파일로 작성 (스키마는 `harness/scripts/write_tc.py` 상단 주석 참고)
   - 실행: `PYTHONUTF8=1 python {PLUGIN_ROOT}/harness/scripts/write_tc.py <input.json>`
   - 결과 stdout(JSON)의 `url`을 사용자에게 보고. `renamed=true`면 탭명 중복으로 변경됐음을 함께 알린다.
5. **파이프라인 호환 — 컨텍스트 마커 유지(필수):**
   기록 후 컨텍스트에 아래를 append 한다 (Phase 4가 참조):
   ```
   ## [Phase 3 완료] TC 목록
   {TC 요약 표 — Case ID·시나리오·기대결과}
   시트: {새 탭 URL}
   ```

## 게이트

- **승인 시:** write_tc.py 실행 → 시트 기록 → 컨텍스트 마커 append
- **거절 시:** 지정 TC만 수정 또는 추가

## 안티패턴

- 초안 게이트 없이 시트에 바로 쓰지 않는다 (공유 시트 오작성 방지)
- 동일 탭명이 있으면 덮어쓰지 않는다 (스크립트가 `_2` suffix로 회피, 사용자에게 고지)
- 입력 산출물이 비었는데 TC를 추측 생성하지 않는다
- 컨텍스트 마커(`## [Phase 3 완료] TC 목록`)를 생략하지 않는다 — 파이프라인이 깨진다
- 목록형 화면 Empty State / API 화면 에러 케이스를 누락하지 않는다

## 텔레메트리 키

- `tc-writer.tc_count` — 생성된 TC 총 수
- `tc-writer.gate_approved` — 게이트 승인 여부 (true/false)
- `tc-writer.sheet_written` — 시트 기록 성공 여부 (true/false)
```

- [ ] **Step 2: 마크다운 구조 확인**

Run: `PYTHONUTF8=1 head -20 /c/claudeT/nestads-product/harness/workflows/tc-writer.md`
Expected: frontmatter `version: 2.0`, `tags`에 `sheet` 포함

- [ ] **Step 3: 커밋**

```bash
git -C /c/claudeT/nestads-product add harness/workflows/tc-writer.md
git -C /c/claudeT/nestads-product commit -m "feat(tc-writer): v2.0 — 출력 대상을 구글시트 신규 템플릿 탭으로 교체"
```

---

### Task 4: OAuth 쓰기 scope 재인증 (1회 수동)

**Files:** 없음 (런타임 토큰 갱신)

- [ ] **Step 1: 기존 읽기전용 토큰 캐시 삭제**

Run: `rm -f "$APPDATA/gspread/authorized_user.json"`
(경로 확인: `ls "$APPDATA/gspread/"` — `credentials.json` 존재해야 함)

- [ ] **Step 2: 쓰기 scope로 재인증 트리거**

Run:
```bash
cd /c/claudeT/nestads-product/harness/scripts
PYTHONUTF8=1 python -c "import write_tc; write_tc._open_client(); print('AUTH OK')"
```
Expected: 브라우저가 열림 → lash@wisebirds.com 로그인/허용 → 콘솔에 `AUTH OK`
(`spreadsheets` 쓰기 scope 동의 화면이 떠야 함)

- [ ] **Step 3: 토큰 재생성 확인**

Run: `ls "$APPDATA/gspread/authorized_user.json"`
Expected: 파일 존재 (재생성됨)

---

### Task 5: E2E dry run (더미 JSON으로 실제 기록 검증)

**Files:**
- Create(임시): `/tmp/tc_dryrun.json`

- [ ] **Step 1: 더미 입력 작성**

`/tmp/tc_dryrun.json`:
```json
{
  "tab_name": "ZZ-DRYRUN",
  "meta": {"title": "DRYRUN 검증용", "start": "26/6/17", "end": "", "author": "라승현", "tester": ""},
  "cases": [
    {"id": "case-001", "component": "매체 어드민", "cat1": "UI 변경", "cat2": "필드명 변경",
     "scenario": "라벨 변경 노출 확인", "precondition": "등록 화면 접근",
     "steps": "1. 진입\n2. 확인", "expected": "라벨이 변경되어 표시됨"},
    {"id": "case-002", "component": "매체 어드민", "cat1": "광고 게재", "cat2": "Empty State",
     "scenario": "데이터 0건 시 빈 상태", "precondition": "결과 0건",
     "steps": "1. 조회", "expected": "Empty 컴포넌트 노출"}
  ]
}
```

- [ ] **Step 2: 기록 실행**

Run: `cd /c/claudeT/nestads-product/harness/scripts && PYTHONUTF8=1 python write_tc.py /tmp/tc_dryrun.json`
Expected: stdout에 `{"name": "ZZ-DRYRUN", "gid": <숫자>, "url": "...", "renamed": false, "count": 2}`

- [ ] **Step 3: 시트 검증**

Run:
```bash
cd /c/claudeT/files
PYTHONUTF8=1 python read_sheet.py <Step2에서 받은 gid>
```
Expected:
- `B1`=DRYRUN 검증용, `D3`=26/6/17, `D5`=라승현
- 12행 case-001, 13행 case-002, 역할칸 N/T
- 집계표 N/T Count=6(2케이스×3), Rate 100% (수식 자동 계산)

- [ ] **Step 4: 검증용 탭 정리**

Run:
```bash
cd /c/claudeT/nestads-product/harness/scripts
PYTHONUTF8=1 python -c "import write_tc as w; gc=w._open_client(); sh=gc.open_by_key(w.DEFAULT_SPREADSHEET_ID); ws=sh.worksheet('ZZ-DRYRUN'); sh.del_worksheet(ws); print('deleted')"
```
Expected: `deleted` (테스트 탭 제거, 원본 템플릿 무손상)

- [ ] **Step 5: 중복 탭명 회피 검증**

`/tmp/tc_dryrun.json`의 `tab_name`을 기존 탭명 `WP-9139`로 바꿔 1회 실행 → stdout `name`이 `WP-9139_2`, `renamed=true` 확인 후 그 탭 삭제(Step 4 방식).

---

### Task 6: 캐시 동기화 + 트리거 확인

**Files:**
- Modify: 플러그인 활성 사본 3곳 (위 "편집 대상 경로")

- [ ] **Step 1: 수정 파일을 활성 사본에 동기화**

Run:
```bash
SRC=/c/claudeT/nestads-product
for DST in \
  "/c/Users/wisebirds/.claude/plugins/marketplaces/wisebirds-marketplace/plugins/nestads-product" \
  "/c/Users/wisebirds/.claude/plugins/cache/wisebirds-marketplace/nestads-product/1.0.0" \
  "/c/Users/wisebirds/.claude/plugins/cache/wb-local-test/nestads-product/1.0.0"; do
  mkdir -p "$DST/harness/scripts"
  cp "$SRC/harness/workflows/tc-writer.md" "$DST/harness/workflows/tc-writer.md"
  cp "$SRC/harness/scripts/write_tc.py" "$DST/harness/scripts/write_tc.py"
done
echo "synced"
```
Expected: `synced`

- [ ] **Step 2: 트리거 무변경 확인**

`triggers.json`의 `tc-writer` 엔트리(keywords/priority/exclusive)는 그대로 유지 — 변경 없음. (출력 동작만 워크플로우 내부에서 바뀜)

Run: `PYTHONUTF8=1 grep -A6 '"id": "tc-writer"' "/c/Users/wisebirds/.claude/plugins/marketplaces/wisebirds-marketplace/plugins/nestads-product/harness/triggers.json"`
Expected: keywords/priority 17/exclusive 유지

- [ ] **Step 3: 원격 푸시 (사용자 승인 후)**

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/wisebirds-bitbucket" git -C /c/claudeT/nestads-product push
```
> 푸시는 사용자 명시 승인 후에만 실행한다.

---

## Self-Review

**Spec coverage:**
- §3.1 데이터 흐름 → Task 3 (tc-writer.md 입력모드/게이트/마커) ✅
- §3.2 스키마 드롭 → Task 3 분류 흡수 + Task 1 build_rows ✅
- §3.3 ① tc-writer.md → Task 3 ✅ / ② write_tc.py → Task 1·2 ✅ / ③ 쓰기 scope → Task 4 ✅ / ④ 캐시 반영 → Task 6 ✅
- §4 에러/엣지 (탭 중복/입력 부족/scope/행 초과/롤백) → dedup_tab_name(Task1·5), 입력부족 안티패턴(Task3), scope(Task4), 행 초과 ValueError(Task2) ✅ — 단 "쓰기 실패 시 새 탭 롤백"은 미구현(아래 갭)
- §5 테스트 → Task 1(단위)·Task 5(E2E) ✅
- §6.1 배포/멀티유저 → Task 2 CREDENTIALS_HELP + Task 4 ✅

**Gap 처리:** §4의 "시트 쓰기 실패 시 새 탭 롤백"은 1차 범위에서 제외(복제 후 batch_update 실패 빈도 낮고, 실패 시 수동 삭제 가능). 운영 중 문제되면 후속 태스크로 try/except 롤백 추가.

**Placeholder scan:** 모든 코드 단계에 실제 코드/명령/기대출력 포함. TBD 없음. ✅

**Type consistency:** `build_rows`(16칼럼), `build_meta_updates`(5셀), `dedup_tab_name`, `write_tc`, `_open_client` 시그니처가 Task 1·2·5 전체에서 일치. 상수(`DATA_START_ROW=12`, `DATA_END_ROW=458`, gid `1348692452`) 일관. ✅
