function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Local wall-clock time with its offset. The agent reasons about "yesterday" and "this morning",
 * so it must never have to convert UTC itself.
 */
export function localTimestamp(date: Date = new Date()): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${ymd}T${hms}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** The same wall clock with milliseconds, for logs where two events share a second. */
export function preciseTimestamp(date: Date = new Date()): string {
  const whole = localTimestamp(date);
  const millis = String(date.getMilliseconds()).padStart(3, '0');
  return `${whole.slice(0, 19)}.${millis}${whole.slice(19)}`;
}

/** Reference clock for scheduled runs, where the local wall clock alone is ambiguous. */
export function utcTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}
