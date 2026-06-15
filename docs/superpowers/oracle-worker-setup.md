# Oracle Cloud 고정IP 워커 — GH IP 403 근본 해결

## 문제
토스 Open API는 **IP 화이트리스트** 기반. GitHub Actions runner는 동적 IP라 등록 불가 → `403 access_denied: IP address not allowed`로 실주문 불가. 로컬 IP도 가정용이라 수시 변동.

## 해결
**Oracle Cloud Always Free VM**(평생 무료) + **Reserved 공인 IP**(고정). 그 IP 하나만 토스 화이트리스트에 등록하고, 워커가 09:03/15:45 KST에 `paper-swing.js`(실주문)를 cron 실행한다.

## 분업 (중요)
| 역할 | 실행 주체 | 비고 |
|---|---|---|
| 데이터 갱신 (가격·랭킹·재무) | **GitHub Actions 유지** | 토스 실패해도 공공데이터 폴백 → 정상 |
| 페이퍼/실주문 (`paper-swing.js`) | **Oracle 워커로 이관** | 고정 IP 필요 |

→ **GH `daily-ranking.yml`에서 `node paper-swing.js` 호출 2곳(ranking·paper 모드)을 제거**해 중복 집행을 막는다. (GH는 토스 403이라 실질 집행은 못 하지만, books 저장 경쟁·로그 혼선 방지를 위해 제거 권장.)

---

## 셋업 단계

### 1. Oracle Always Free VM 생성
- oracle.com/cloud/free → 가입 (해외결제 카드 인증, 과금 없음)
- Compute → Instances → Create
- Shape: **VM.Standard.E2.1.Micro** (Always Free 대상) 또는 A1.Flex(ARM, 무료 한도 내)
- Image: Ubuntu 22.04
- SSH 키 등록 후 생성

### 2. Reserved 공인 IP 확보 (고정)
- 생성된 인스턴스의 Public IP는 기본 "Ephemeral"(재부팅 시 변동 가능)
- Networking → IP Addresses → Public IP → **Reserved로 변경** (Always Free 무료)
- 이 IP를 메모 → 토스에 등록할 값

### 3. 토스 화이트리스트에 Oracle IP 등록
- 토스증권 WTS → 설정 → Open API → 허용 IP에 **위 Reserved IP 추가**
- (로컬 개발 IP와 함께 복수 등록 가능하면 둘 다 유지)

### 4. VM에 repo·node·.env 배치
```bash
# VM SSH 접속 후
sudo apt update && sudo apt install -y git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
git clone https://github.com/LaSeunghyun/krxdata.git ~/krxdata
cd ~/krxdata && npm install

# .env 생성 (로컬 .env와 동일 내용 — secret 등)
nano ~/krxdata/.env   # TOSS_CLIENT_ID/SECRET, SUPABASE_*, TELEGRAM_* 채우기
```

### 5. 인증·dry-run 검증 (실주문 0)
```bash
cd ~/krxdata
node -e "import('./toss-api.js').then(m=>m.getAccounts()).then(a=>console.log('OK',a[0].accountNo)).catch(e=>console.log('FAIL',e.message))"
# → OK 17001013343 나와야 (Oracle IP가 토스 허용된 것 확인)

LIVE_DRY_RUN=1 LIVE_QUEUE_ONLY=1 node paper-swing.js
# → 큐 있으면 [DRY] BUY... 로그, 실주문 0
```

### 6. crontab 등록 (VM은 UTC 기준)
```bash
crontab -e
```
```cron
# KST 09:03 (UTC 00:03) morning — 전일 큐 실주문 집행
3 0 * * 1-5 cd /home/ubuntu/krxdata && /usr/bin/node paper-swing.js >> /home/ubuntu/krx-paper.log 2>&1
# KST 15:45 (UTC 06:45) close — 종가 판정 + 익일 큐 생성
45 6 * * 1-5 cd /home/ubuntu/krxdata && /usr/bin/node paper-swing.js >> /home/ubuntu/krx-paper.log 2>&1
```
- `paper-swing.js`는 `kstHM()`로 morning/close phase를 자동 판정 → cron 시각만 맞으면 됨
- 공휴일은 `getKrMarketCalendar()`가 자동 휴장 처리

### 7. 첫 거래일 모니터링
- 첫 실행일 09:03 후 `~/krx-paper.log` 확인 + 텔레그램 체결 알림 확인
- 새 BUY 큐가 처음 생길 때 **`LIVE_DRY_RUN=1`로 먼저 1회** 돌려 차순위 분산(allocateSlots) 동작을 눈으로 확인 후 실집행 권장

---

## 코드 동기화
워커는 `git pull`로 최신 코드를 받는다. 코드 변경 push 후 VM에서:
```bash
cd ~/krxdata && git pull && npm install
```
(자동화하려면 crontab에 `git pull` 선행 또는 별도 deploy 훅)

## 잔여 리스크
- Oracle Always Free는 장기 미사용 시 회수 정책이 있을 수 있음(주기적 활동 권장 — cron이 매일 도니 해당 없음)
- VM 단일 장애점 → 다운 시 그날 미집행(큐는 보존, 복구 후 재집행). 모니터링 알림(텔레그램) 유지
- toss-api는 body·Basic Auth 둘 다 동작 확인됨(현재 Basic) — 인증 방식 변경 불필요
