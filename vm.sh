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
  ask)
    shift
    AT='Read,Glob,Grep,Bash(node status.mjs:*),Bash(node stock-live.mjs --plan:*),Bash(node forecast-skill.mjs:*),Bash(sudo journalctl -u stock-live:*)'
    $SSH "cd ~/krxdata && claude -p \"$*\" --append-system-prompt '조회·분석·운영만. 실주문·코드수정·웹 금지.' --allowedTools '$AT' --disallowedTools Write,Edit,WebFetch,WebSearch" ;;
  *)
    echo "usage: bash vm.sh {status | log [n] | restart | bot-restart | ask <질문>}" ;;
esac
