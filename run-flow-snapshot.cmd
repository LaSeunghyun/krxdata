@echo off
cd /d C:\claudeT\files
node flow-snapshot.mjs --limit 40 >> flow-snapshot-log.txt 2>&1
