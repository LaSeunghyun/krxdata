/**
 * KRXDATA Monitor — server.js
 * Express ESM 서버 (포트 7799)
 * SSE로 진행률 실시간 스트리밍
 */
import express from 'express';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = join(__dirname, '.update-status.json');
const DAILY_RANKING = join(__dirname, 'daily-ranking.js');
const PUBLIC_DIR = join(__dirname, 'public');

// ---------- 상태 관리 ----------
const DEFAULT_STATUS = {
  running: false,
  mode: null,
  progress: 0,
  total: 2610,
  current: '대기 중',
  startedAt: null,
  lastDone: null,
  log: []
};

function loadStatus() {
  try {
    if (existsSync(STATUS_FILE)) {
      return JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
    }
  } catch {}
  return { ...DEFAULT_STATUS };
}

function saveStatus(patch) {
  const prev = loadStatus();
  const next = { ...prev, ...patch };
  writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

function appendLog(status, line) {
  const log = [...(status.log || []), line].slice(-50);
  return { ...status, log };
}

// ---------- SSE 브로드캐스트 ----------
const sseClients = new Set();

function broadcast(status) {
  const data = JSON.stringify(status);
  for (const res of sseClients) {
    res.write(`data: ${data}\n\n`);
  }
}

// ---------- 진행률 파싱 ----------
function parseLine(line, status) {
  const ts = new Date().toLocaleTimeString('ko-KR');
  const tagged = `[${ts}] ${line}`;

  let patch = appendLog(status, tagged);

  // 진행: N/TOTAL
  const progressMatch = line.match(/진행:\s*(\d+)\/(\d+)/);
  if (progressMatch) {
    const done = parseInt(progressMatch[1], 10);
    const total = parseInt(progressMatch[2], 10);
    const pct = Math.round((done / total) * 100);
    patch = {
      ...patch,
      progress: pct,
      total,
      current: `가격 업데이트 중 (${done}/${total})`
    };
  }

  if (line.includes('[가격 업데이트]') && line.includes('종목 시작')) {
    const m = line.match(/(\d+)개 종목/);
    patch = {
      ...patch,
      progress: 0,
      total: m ? parseInt(m[1], 10) : 2610,
      current: '가격 업데이트 시작'
    };
  }

  if (line.includes('[가격 업데이트 완료]')) {
    patch = { ...patch, progress: 50, current: '가격 업데이트 완료' };
  }

  if (line.includes('[가격 업데이트 스킵]')) {
    patch = { ...patch, progress: 10, current: '가격 업데이트 스킵됨' };
  }

  if (line.includes('[랭킹 계산] 시작')) {
    patch = { ...patch, progress: patch.progress || 50, current: '랭킹 계산 중...' };
  }

  if (line.includes('[랭킹 저장 완료]')) {
    patch = { ...patch, progress: 90, current: '랭킹 저장 완료' };
  }

  if (line.includes('[완료]')) {
    const now = new Date().toLocaleString('ko-KR');
    patch = {
      ...patch,
      running: false,
      progress: 100,
      current: '완료',
      lastDone: now
    };
  }

  if (line.includes('[오류]')) {
    patch = { ...patch, running: false, current: `오류 발생: ${line}` };
  }

  return patch;
}

// ---------- 프로세스 실행 ----------
let activeProcess = null;

function runDailyRanking(mode) {
  if (activeProcess) return { error: '이미 실행 중입니다.' };

  const args = ['daily-ranking.js'];
  if (mode === 'ranking') args.push('--skip-price');

  let status = saveStatus({
    running: true,
    mode,
    progress: 0,
    current: mode === 'ranking' ? '랭킹 업데이트 시작...' : '가격+랭킹 업데이트 시작...',
    startedAt: new Date().toISOString(),
    log: [`[${new Date().toLocaleTimeString('ko-KR')}] 실행 시작 (mode: ${mode})`]
  });
  broadcast(status);

  const proc = spawn('node', args, {
    cwd: __dirname,
    env: process.env
  });
  activeProcess = proc;

  proc.stdout.setEncoding('utf-8');
  proc.stderr.setEncoding('utf-8');

  let buf = '';
  const handleChunk = (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop(); // 마지막 불완전 줄 보류
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      status = parseLine(trimmed, status);
      status = saveStatus(status);
      broadcast(status);
    }
  };

  proc.stdout.on('data', handleChunk);
  proc.stderr.on('data', (chunk) => {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    const ts = new Date().toLocaleTimeString('ko-KR');
    status = appendLog(status, `[${ts}] [STDERR] ${trimmed}`);
    status = saveStatus(status);
    broadcast(status);
  });

  proc.on('close', (code) => {
    activeProcess = null;
    // 아직 running이 true면 완료 처리
    const current = loadStatus();
    if (current.running) {
      const now = new Date().toLocaleString('ko-KR');
      const final = saveStatus({
        ...current,
        running: false,
        progress: code === 0 ? 100 : current.progress,
        current: code === 0 ? '완료' : `프로세스 종료 (코드 ${code})`,
        lastDone: code === 0 ? now : current.lastDone
      });
      broadcast(final);
    }
  });

  proc.on('error', (err) => {
    activeProcess = null;
    const errStatus = saveStatus({ ...status, running: false, current: `실행 오류: ${err.message}` });
    broadcast(errStatus);
  });

  return { started: true, mode };
}

// ---------- Express 앱 ----------
const app = express();
app.use(express.json());

// GET / → index.html
app.get('/', (req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json(loadStatus());
});

// POST /api/run?mode=full|ranking
app.post('/api/run', (req, res) => {
  const mode = req.query.mode === 'ranking' ? 'ranking' : 'full';
  const result = runDailyRanking(mode);
  if (result.error) return res.status(409).json(result);
  res.json(result);
});

// POST /api/stop — 실행 중인 프로세스 강제 종료
app.post('/api/stop', (req, res) => {
  if (!activeProcess) return res.status(400).json({ error: '실행 중인 프로세스 없음' });
  activeProcess.kill('SIGTERM');
  const stopped = saveStatus({ ...loadStatus(), running: false, current: '사용자가 중단함' });
  broadcast(stopped);
  res.json({ stopped: true });
});

// GET /api/stream → SSE
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // 현재 상태 즉시 전송
  const current = loadStatus();
  res.write(`data: ${JSON.stringify(current)}\n\n`);

  sseClients.add(res);

  // keepalive ping (30초)
  const ping = setInterval(() => {
    res.write(': ping\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ---------- 시작 ----------
const PORT = 7799;
app.listen(PORT, () => {
  console.log(`KRXDATA Monitor → http://localhost:${PORT}`);
});
