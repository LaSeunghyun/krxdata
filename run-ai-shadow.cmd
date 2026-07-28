@echo off
REM run-ai-shadow.cmd — AI 판단 트레이더 SHADOW 일일 실행 (실주문 없음).
REM 장마감+수급갱신(flow-snapshot 18:00) 이후 18:30 실행 → Toss 토큰경합 회피 + 수급 신선.
cd /d C:\claudeT\files
node ai-shadow.mjs --days 2 --max 40 >> ai-shadow-cron.log 2>&1
