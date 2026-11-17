import { loadConfig } from '../config.js';
import { formatLogRecord, logsDir, readLogEvents } from '../core/log.js';

interface ParsedOptions {
  scopes: string[];
  lines?: number;
  days?: number;
  event?: string;
  eventId?: string;
  json?: boolean;
}

const DEFAULT_LINES = 40;

function usage(): never {
  console.error(`Usage:
  retriever log [scope...] [--lines <n>] [--days <n>] [--event <prefix>] [--event-id <id>] [--json]`);
  process.exit(2);
}

function parseOptions(args: string[]): ParsedOptions {
  const out: ParsedOptions = { scopes: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--lines') out.lines = count(needValue(args, ++i, arg), arg);
    else if (arg === '--days') out.days = count(needValue(args, ++i, arg), arg);
    else if (arg === '--event') out.event = needValue(args, ++i, arg);
    else if (arg === '--event-id') out.eventId = needValue(args, ++i, arg);
    else if (arg.startsWith('--')) usage();
    else out.scopes.push(arg);
  }
  return out;
}

function needValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function count(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`${flag} requires a positive integer`);
  return number;
}

export function runLogCli(args: string[]): void {
  const opts = parseOptions(args);
  const config = loadConfig();
  const lines = opts.lines ?? DEFAULT_LINES;
  let records = readLogEvents(config, { scopes: opts.scopes, days: opts.days ?? 1 });
  if (opts.event)
    records = records.filter((record) => String(record.event).startsWith(opts.event as string));
  if (opts.eventId) records = records.filter((record) => record.event_id === opts.eventId);
  const tail = records.slice(-lines);
  if (!tail.length) {
    console.error(`no events in ${logsDir(config)} for the selected scopes, days and filters`);
    return;
  }
  console.log(
    opts.json
      ? JSON.stringify(tail, null, 2)
      : tail.map((record) => formatLogRecord(record)).join('\n'),
  );
}
