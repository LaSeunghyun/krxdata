#!/bin/bash
# vm.sh — 로컬에서 Oracle VM(클라우드 트레이더) 제어·대화 헬퍼 (2026-07-21).
#   사용: bash vm.sh {status|log [n]|restart|ask <질문>|bot-restart}
#   ask = 클라우드 Claude와 대화(조회·분석·운영). 주식 얘기를 클라우드 통해 주고받는 채널.
IP=134.185.111.69
KEY="$HOME/.ssh/oracle-vm"
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new ubuntu@$IP"
case "$1" in
  status)
    $SSH 'echo "stock-live: $(systemctl is-active stock-live)"; echo "telegram-agent: $(systemctl is-active telegram-agent 2>/dev/null || echo n/a)"; echo "--- 최근 매매/시작 ---"; sudo journalctl -u stock-live -n 5 --no-pager' ;;
  log)
    $SSH "sudo journalctl -u stock-live -n ${2:-40} --no-pager" ;;
  restart)
    $SSH 'sudo systemctl restart stock-live && echo restarted' ;;
  bot-restart)
    $SSH 'sudo systemctl restart telegram-agent && echo bot-restarted' ;;
  deploy)
    # ★ 2026-07-30 추가: VM의 ~/krxdata 는 **git 레포가 아니다**(`git pull` 하면 fatal).
    #   지금까지 배포 수단이 없어 수동 scp였다. 파일을 **명시적으로** 받아 전송하고 md5로 검증한다.
    #   전체 동기(rsync *.mjs)를 하지 않는 이유: VM에만 있는 상태파일·연구스크립트를 건드릴 위험.
    shift
    if [ $# -eq 0 ]; then echo "usage: bash vm.sh deploy <file> [file...]"; exit 1; fi
    for f in "$@"; do [ -f "$f" ] || { echo "없는 파일: $f"; exit 1; }; done
    scp -i "$KEY" -o StrictHostKeyChecking=accept-new "$@" "ubuntu@$IP:~/krxdata/" || { echo "전송 실패"; exit 1; }
    echo "--- md5 검증 ---"
    for f in "$@"; do
      b=$(basename "$f")
      L=$(md5sum "$f" | awk '{print $1}')
      R=$($SSH "md5sum ~/krxdata/$b 2>/dev/null | awk '{print \$1}'")
      if [ "$L" = "$R" ]; then echo "  OK   $b"; else echo "  ★불일치 $b (로컬 $L / VM $R)"; fi
    done
    echo "※ 반영에는 재시작이 필요하다: bash vm.sh restart (stock-live) / bash vm.sh wd-restart (watchdog)"
    ;;
  wd-restart)
    $SSH 'sudo systemctl restart watchdog && sleep 2 && systemctl is-active watchdog && journalctl -u watchdog -n 2 --no-pager' ;;
  ask)
    shift
    AT='Read,Glob,Grep,Bash(node status.mjs:*),Bash(node stock-live.mjs --plan:*),Bash(node forecast-skill.mjs:*),Bash(sudo journalctl -u stock-live:*)'
    $SSH "cd ~/krxdata && claude -p \"$*\" --append-system-prompt '조회·분석·운영만. 실주문·코드수정·웹 금지.' --allowedTools '$AT' --disallowedTools Write,Edit,WebFetch,WebSearch" ;;
  *)
    echo "usage: bash vm.sh {status | log [n] | restart | bot-restart | ask <질문>}" ;;
esac
