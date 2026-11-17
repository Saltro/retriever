import fs from 'node:fs';
import path from 'node:path';
import { preciseTimestamp } from '../prompts/time.js';
import type { AppConfig } from '../types.js';
import { stateDir } from './state/paths.js';

const RETENTION_DAYS = 14;
const prunedDirs = new Set<string>();

export type LogField = string | number | boolean | null | undefined;

export type LogRecord = Record<string, unknown> & {
  ts: string;
  scope: string;
  event: string;
};

export interface ReadLogOptions {
  scopes?: string[];
  /** Local days to read, today included. */
  days?: number;
  now?: Date;
}

const SCOPES = /[^a-z0-9-]/g;

export function logsDir(config: AppConfig): string {
  return path.join(stateDir(config), 'logs');
}

/** One event, one line: `logs/<scope>-YYYY-MM-DD.ndjson` keeps a turn readable with jq. */
export function logEvent(
  config: AppConfig,
  scope: string,
  event: string,
  fields: Record<string, LogField> = {},
): void {
  const now = new Date();
  const record: Record<string, string | number | boolean | null> = {
    ts: preciseTimestamp(now),
    scope: scope.replace(SCOPES, '-'),
    event,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) record[key] = value;
  }
  try {
    const dir = logsDir(config);
    fs.mkdirSync(dir, { recursive: true });
    pruneOnce(dir, now);
    fs.appendFileSync(
      path.join(dir, `${record.scope}-${dayStamp(now)}.ndjson`),
      `${JSON.stringify(record)}\n`,
    );
  } catch (error) {
    // A log that cannot be written must never turn into a failed turn.
    console.error(`[log] write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.error(formatLogRecord(record));
}

/** Newest last, across every scope it was asked for. */
export function readLogEvents(config: AppConfig, options: ReadLogOptions = {}): LogRecord[] {
  const { scopes, days = 1, now = new Date() } = options;
  const dir = logsDir(config);
  if (!fs.existsSync(dir)) return [];
  const wanted = scopes?.length ? new Set(scopes) : undefined;
  const dates = new Set<string>();
  for (let index = 0; index < Math.max(1, days); index++) {
    // Building the date from the calendar avoids a DST day being skipped or doubled.
    dates.add(dayStamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() - index)));
  }
  const records: LogRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    const match = /^(.+)-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name);
    if (!match) continue;
    if (wanted && !wanted.has(match[1])) continue;
    if (!dates.has(match[2])) continue;
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as LogRecord;
        if (record?.event) records.push(record);
      } catch {
        // A torn final line is not worth failing the read over.
      }
    }
  }
  // Milliseconds keep two events written in the same second in order; the epoch
  // comparison also survives records that were written under different offsets.
  return records.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
}

/** The one rendering, shared by the stderr mirror and `retriever log`. */
export function formatLogRecord(record: Record<string, unknown>): string {
  const { ts, scope, event, ...fields } = record;
  const pairs = Object.entries(fields).map(([key, value]) => {
    if (typeof value === 'string' && /[\s"=]/.test(value)) return `${key}=${JSON.stringify(value)}`;
    if (value !== null && typeof value === 'object') return `${key}=${JSON.stringify(value)}`;
    return `${key}=${String(value)}`;
  });
  return [`${String(ts)} [${String(scope)}] ${String(event)}`, ...pairs].join(' ');
}

/** Local day for the file name, so a log file matches the timestamps inside it. */
function dayStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function pruneOnce(dir: string, now: Date): void {
  if (prunedDirs.has(dir)) return;
  prunedDirs.add(dir);
  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ndjson')) continue;
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  } catch (error) {
    console.error(`[log] prune failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
