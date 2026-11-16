import type { AppConfig } from '../../types.js';
import { getStateDb } from './db.js';

/** The one chat a person actually sees; inputs may come from anywhere. */
export interface VisibleBinding {
  chatId: string;
  createdAt: string;
  updatedAt: string;
  source?: string;
}

function bindingFromRow(row: Record<string, unknown>): VisibleBinding {
  return {
    chatId: String(row.chatId),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    source: row.source == null ? undefined : String(row.source),
  };
}

export function readVisibleBinding(config: AppConfig): VisibleBinding | undefined {
  const row = getStateDb(config).prepare('SELECT * FROM visible_binding WHERE singleton = 1').get();
  return row ? bindingFromRow(row) : undefined;
}

export function writeVisibleBinding(
  config: AppConfig,
  chatId: string,
  source = 'manual',
): VisibleBinding {
  if (!chatId.trim()) throw new Error('visible chat binding requires a nonempty chat id');
  const now = new Date().toISOString();
  const row = getStateDb(config)
    .prepare(`INSERT INTO visible_binding(singleton, chatId, createdAt, updatedAt, source)
    VALUES (1, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
    chatId=excluded.chatId, updatedAt=excluded.updatedAt, source=excluded.source RETURNING *`)
    .get(chatId, now, now, source);
  if (!row) throw new Error('visible chat binding insert returned no row');
  return bindingFromRow(row);
}

export function ensureVisibleBinding(
  config: AppConfig,
  chatId: string,
  source = 'auto',
): VisibleBinding {
  if (!chatId.trim()) throw new Error('visible chat binding requires a nonempty chat id');
  const now = new Date().toISOString();
  const db = getStateDb(config);
  db.prepare(
    'INSERT OR IGNORE INTO visible_binding(singleton, chatId, createdAt, updatedAt, source) VALUES (1, ?, ?, ?, ?)',
  ).run(chatId, now, now, source);
  const binding = readVisibleBinding(config);
  if (!binding) throw new Error('visible chat binding missing after upsert');
  return binding;
}
