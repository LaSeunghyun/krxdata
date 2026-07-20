# NestAds TC Writer — 구글시트 기록 방식으로 교체 (설계)

**작성일:** 2026-06-17
**대상 워크플로우:** `tc-writer` (nestads-product 플러그인 harness)
**상태:** 설계 확정 대기

---

## 1. 배경 및 목적

현재 NestAds 기획 파이프라인의 TC 작성 단계(`tc-writer` 워크플로우)는 **채팅에 마크다운 TC 테이블**을 출력한다. 이를 **공유 구글 스프레드시트(`TestCase_Nestads_26년 2분기 이후`)에 신규 템플릿 형식의 새 탭을 만들어 기록**하는 방식으로 교체한다.

목적:
- TC 산출물을 팀 공용 QA 시트에 바로 적재 → 채팅 복붙 수작업 제거
- 기존 시트의 **신규 템플릿** 칼럼·집계 수식·서식을 그대로 활용

---

## 2. 현재 구조 (as-is)

- **소스 위치(편집 대상):** `C:\claudeT\nestads-product\harness\workflows\tc-writer.md` (Bitbucket 레포)
  - 사본: `~/.claude/plugins/marketplaces/.../nestads-product/...` 및 `cache/...` 2곳
- **트리거:** `triggers.json` id=`tc-writer`, keywords `["TC 작성해줘","테스트 케이스 써줘","QA 시나리오","TC 써줘"]`, priority 17, exclusive
- **실행 모드:** 독립 실행 또는 `nestads-pipeline` Phase 3
- **입력:** 유저스토리 + 사용자 여정 (Phase 2 출력 또는 직접 제공)
- **출력:** 마크다운 TC 테이블 (TC-ID·분류·시나리오·사전조건·단계·기대·우선순위)
- **게이트:** 승인 후 `## [Phase 3 완료] TC 목록` 마커를 컨텍스트에 append (파이프라인 Phase 4가 참조)

---

## 3. 목표 구조 (to-be)

### 3.1 데이터 흐름

```
tc-writer 트리거 / 파이프라인 Phase 3
   │
   ├─ 1. 입력 취합
   │     [파이프라인] 컨텍스트의 "## [Phase 2 완료] 유저스토리 + 여정" 탐색
   │     [독립 실행]   Jira(getJiraIssue) + Confluence(getConfluencePage) + 기획서/Figma URL 취합
   │
   ├─ 2. TC 생성 (신규 템플릿 스키마)
   │     Case ID · Component · Category1 · Category2 · 테스트 시나리오
   │     · 사전 조건 · 테스트 단계 · 기대 결과 · 역할6컬럼(전부 N/T) · BUG ID(빈) · Comment
   │
   ├─ 3. 초안 게이트  ★승인 필수
   │     생성 TC를 채팅에 표로 제시 → 사용자 승인
   │
   └─ 4. 기록 + 컨텍스트 마커
         write_tc.py 실행: 신규 템플릿 탭 복제 → 'WP-xxxx' 새 탭 → 메타+TC행 기입
         새 탭 URL 보고
         + 컨텍스트에 "## [Phase 3 완료] TC 목록" 마커 append (요약표 + 시트 URL)  ← 파이프라인 호환
```

### 3.2 스키마 결정

- **신규 템플릿 스키마만 따른다.** 기존 분류(정상/엣지/에러/권한)·우선순위(P0/P1) 칼럼은 **드롭**.
- TC 생성 시 자동 도출 기준(Empty State, 로딩, 에러 Toast, 권한 케이스)은 **시나리오 내용으로 흡수**하되 별도 칼럼은 만들지 않는다.

### 3.3 컴포넌트

**① `tc-writer.md` (재작성)**
- 입력 절차: 파이프라인/독립 두 모드 분기 명시
- 출력 절차: 마크다운 출력 → "생성 → 초안 게이트 → `write_tc.py` 호출 → 새 탭 URL 보고 + 컨텍스트 마커 유지"
- 안티패턴/텔레메트리 키 유지 (`tc_count`, `gate_approved`, 신규 `sheet_written`)

**② `write_tc.py` (신규, 레포 `harness/scripts/`)**
- 입력: JSON 파일 (에이전트가 생성)
  ```json
  {
    "spreadsheet_id": "1IFYgvMJMVwJKYhkunUcDIh0JZQofyAfro2BT16qZky0",
    "template_gid": 1348692452,
    "tab_name": "WP-9201",
    "meta": {"title":"...", "start":"26/6/20", "end":"", "author":"라승현", "tester":""},
    "cases": [
      {"id":"case-001","component":"매체 어드민","cat1":"UI 변경","cat2":"필드명 변경",
       "scenario":"...","precondition":"...","steps":"...","expected":"..."}
    ]
  }
  ```
- 동작:
  1. `duplicate_sheet(template_gid → tab_name)` — 서식·집계 수식·그룹화 보존
  2. 메타 셀 기입: `B1`=title, `D4`=start, `D5`=end, `D6`=author, `D7`=tester
     (정확한 좌표는 구현 시 live 템플릿을 좌표째 읽어 확정)
  3. 예시행(case-001~) 영역 클리어 후 행 13부터 TC 기입
     - 칼럼: `B`=Case ID … `I`=기대결과, `J~O`=역할(전부 `N/T`), `P`=BUG ID(빈), `Q`=Comment
  4. 새 탭 `gid` + URL 출력 (stdout JSON)
- 인증: gspread OAuth, scope `spreadsheets`(읽기+쓰기). 자격증명 `~/AppData/Roaming/gspread/credentials.json`

**③ OAuth 쓰기 scope 전환**
- 현재 토큰은 읽기전용(`spreadsheets.readonly`). 쓰기엔 `spreadsheets` 필요.
- `authorized_user.json` 1회 삭제 → 재실행 시 브라우저 재동의(이후 자동).

**④ 캐시 반영**
- 레포(`C:\claudeT\nestads-product`) 수정분을 플러그인 캐시 2곳에 동기화 (또는 `/plugin` 재설치).

---

## 4. 에러 / 엣지 처리

| 상황 | 처리 |
|------|------|
| 동일 `tab_name` 탭 이미 존재 | 덮어쓰기 금지 → `WP-xxxx_2` 등 suffix 제안 후 사용자 확인 |
| 입력 산출물 부족(Jira/Confluence 비어있음) | 중단하고 사용자에게 소스 요청 (추측 생성 금지) |
| OAuth 토큰 만료/scope 부족 | `authorized_user.json` 삭제 후 재동의 안내 |
| 집계 수식 행 범위 초과(TC가 템플릿 기본 행 수 초과) | 수식 범위 확장 또는 행 추가 후 기입 |
| 시트 쓰기 실패 | 새 탭 생성분 롤백(삭제) 후 에러 보고 |

---

## 5. 테스트 / 검증

- `write_tc.py`를 더미 JSON(2~3 케이스)으로 실행 → 새 탭 생성·메타·행·집계표 정상 확인
- 신규 템플릿 탭은 보존(복제만), 원본 미변경 확인
- 파이프라인 Phase 3 후 Phase 4가 컨텍스트 마커를 정상 인식하는지 확인
- 독립 실행 모드: 실제 Jira 티켓키로 취합→초안→승인→기록 1회 E2E

---

## 6. 비기능 / 운영

- 자격증명 파일(`credentials.json`, `authorized_user.json`)은 **git 커밋 금지** (.gitignore 확인)
- `spreadsheet_id`·`template_gid`는 스크립트 기본값으로 두되 JSON으로 override 가능
- 공유 시트 오작성 방지: **초안 게이트 필수**, 탭 중복 시 덮어쓰기 금지

---

## 6.1 배포 / 멀티유저 (OAuth 자격증명)

플러그인은 **코드만** 포함하고 자격증명은 포함하지 않는다.

| 파일 | 동봉 | 비고 |
|------|------|------|
| `tc-writer.md`, `write_tc.py` | ✅ | 플러그인에 포함 |
| `credentials.json` (OAuth 클라이언트 ID) | ❌ | 사내 별도 전달 또는 각자 발급 |
| `authorized_user.json` (개인 토큰) | ❌ | 각자 본인 Google 계정 1회 로그인 시 자동 생성 |

**배포 정책: 공용 데스크톱 OAuth 클라이언트 1개를 사내 공유(안 A).**
- 데스크톱 앱 클라이언트는 public client → 팀 내 공유 무방
- 받는 사람: `credentials.json`을 `~/AppData/Roaming/gspread/`에 배치 → 첫 실행 시 본인 계정 로그인
- 시트 접근 권한은 **사용자 본인 Google 계정 권한**을 따름 (와이즈버즈 조직 공유 시트 → 정상 동작)

**`write_tc.py` 동작 요구사항:**
- `credentials.json` 부재 시 → 에러 대신 **세팅 안내 메시지**(파일 위치 + GCP 발급 절차 요약) 출력 후 종료
- `authorized_user.json` 부재/만료 시 → 브라우저 재인증 플로우 자동 시작
- 서비스 계정 방식은 채택하지 않음 (외부공유 차단 + 키 동봉 위험)

---

## 7. 범위 밖 (YAGNI)

- TC 결과(Pass/Fail) 자동 업데이트 — 이번 범위 아님 (작성만)
- 다중 스프레드시트 지원 — 단일 TestCase 시트 고정
- 우선순위/분류 칼럼 복원 — 드롭 확정
