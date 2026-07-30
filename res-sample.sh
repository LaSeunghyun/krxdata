#!/bin/bash
# res-sample.sh — 1분 간격 자원·네트워크 스냅샷 (2026-07-30)
# 목적: 07-30 09:02~10:26 장애의 원인 확증. 당시 SSH·Toss·KIS가 동시 타임아웃했고
#       OOM은 없었으며 CPU는 2코어인데 커널이 psi_avgs_work hogged CPU를 찍었다.
#       가설 = VM 네트워크 포화(크론 겹침). 재발 시 아래 지표로 판별한다.
#       · rx/tx 바이트 증가율이 평시 대비 급증 → 네트워크 포화 확증
#       · load/mem 정상인데 네트워크만 급증 → CPU·메모리 원인 배제
# 출력: ~/krxdata/res-sample.log (append). 로그 회전은 아래 tail 자체 절단으로 처리.
L=~/krxdata/res-sample.log
IF=$(ip route | awk "/^default/{print \$5; exit}")
read -r RX TX < <(awk -v i="$IF" '$1 ~ i":" {gsub(/:/,"",$1); print $2, $10}' /proc/net/dev)
LOAD=$(awk "{print \$1}" /proc/loadavg)
MEM=$(free -m | awk "/^Mem:/{print \$3\"/\"\$2\"MB avail \"\$7}")
NCONN=$(ss -tn state established 2>/dev/null | wc -l)
NPROC=$(pgrep -c node)
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) load=$LOAD mem=$MEM conn=$NCONN node=$NPROC rx=$RX tx=$TX" >> $L
# 20000줄 초과 시 뒤 10000줄만 유지 (약 2주분)
if [ "$(wc -l < $L)" -gt 20000 ]; then tail -10000 $L > $L.tmp && mv $L.tmp $L; fi
