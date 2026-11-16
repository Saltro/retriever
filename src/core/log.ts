import fs from 'node:fs';
import path from 'node:path';
import { localTimestamp } from '../prompts/time.js';
import type { AppConfig } from '../types.js';
import { stateDir } from './state/paths.js';

const RETENTION_DAYS = 14;
const prunedDirs = new Set<string>();

export type LogField = string | number | boolean | null | undefined;

const SCOPES = /[^a-z0-9-]/g;

/** One event, one line: `logs/<scope>-YYYY-MM-DD.ndjson` keeps a turn readable with jq. */
export function logEvent(
  config: AppConfig,
  scope: string,
  event: string,
  fields: Record<string, LogField> = {},
): void {
  const now = new Date();
  const record: Record<string, string | number | boolean | null> = {
    ts: localTimestamp(now),
    scope: scope.replace(SCOPES, '-'),
    event,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) record[key] = value;
  }
  try {
    const dir = path.join(stateDir(config), 'logs');
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
  console.error(renderLine(record));
}

/** Local day for the file name, so a log file matches the timestamps inside it. */
function dayStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Values with spaces would make the human line unreadable, so only those get quoted. */
function renderLine(record: Record<string, string | number | boolean | null>): string {
  const { ts, scope, event, ...fields } = record;
  const pairs = Object.entries(fields).map(([key, value]) =>
    typeof value === 'string' && /[\s"=]/.test(value)
      ? `${key}=${JSON.stringify(value)}`
      : `${key}=${String(value)}`,
  );
  return [`${ts} [${scope}] ${event}`, ...pairs].join(' ');
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
