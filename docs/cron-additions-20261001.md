# VM crontab 추가분 (2026-10-01, 패키지 B)

VM(`ubuntu@134.185.111.69:~/krxdata`)은 git 이 아니라서 crontab 이 레포에 없다.
추가한 줄을 여기에 기록한다. 기존 줄은 수정·삭제하지 않았다. 시각은 UTC.
추가 전 백업: VM `~/crontab.bak-20261001`.

```
# 2026-10-01 패키지B 신규 수집기 (UTC). 신용/공매도/대차 05:00KST, CB-BW 06:10KST, 실적캘린더 06:20KST, 해외지표 08:20KST
0 20 * * 0-5 cd /home/ubuntu/krxdata && flock -n /tmp/collect-kis-extra.lock /usr/bin/node collect-kis-extra.mjs --limit 420 >> /home/ubuntu/krxdata/kis-extra-cron.log 2>&1
10 21 * * * cd /home/ubuntu/krxdata && flock -n /tmp/collect-cbbw.lock /usr/bin/node collect-cbbw.mjs >> /home/ubuntu/krxdata/cbbw-cron.log 2>&1
20 21 * * * cd /home/ubuntu/krxdata && flock -n /tmp/collect-earnings.lock /usr/bin/node collect-earnings-calendar.mjs >> /home/ubuntu/krxdata/earnings-cron.log 2>&1
20 23 * * 0-5 cd /home/ubuntu/krxdata && flock -n /tmp/collect-global.lock /usr/bin/node collect-global.mjs >> /home/ubuntu/krxdata/global-cron.log 2>&1
```

기존 줄 `0 9 * * * ... flow-snapshot.mjs --limit 420` 은 그대로이며 개정된 코드를 실행한다.

## 추가 방법 (재현용)
```
flock /tmp/crontab.lock -c 'crontab -l > /tmp/ct.$$ && echo "<줄>" >> /tmp/ct.$$ && crontab /tmp/ct.$$'
```

## 롤백
위 5줄(주석 1 + 작업 4)만 `crontab -e` 로 지운다. 신규 테이블은 비워도 되고 그대로 두어도 무해하다.

## KIS 앱키 공유
모든 KIS 수집기는 앱키를 flow-snapshot·forecast·섀도우와 공유한다.
`collect-kis-extra.mjs` 는 평일 KST 09:00-15:30 에 `--limit` 3 초과면 종료한다(`--force-market-hours` 로만 우회).
KIS 재시도 계층은 호출당 한 겹이다: `kis-extra.mjs` 는 최대 3회, `flow-snapshot.mjs` 는 `kis-api.js` 내부 4회 + 바깥은 네트워크 오류 1회만.
