const KST_TZ = 'Asia/Seoul';
const kstDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: KST_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const kstTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function toUtcIso(date = new Date()) {
  return new Date(date).toISOString();
}

export function toKstDateKey(date = new Date()) {
  return kstDateFormatter.format(new Date(date)).replaceAll('-', '');
}

export function toKstTimeLabel(date = new Date()) {
  return kstTimeFormatter.format(new Date(date));
}

export function kstDayRange(yyyyMmDd) {
  const start = new Date(`${yyyyMmDd}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return [start, end];
}
