import { MAIN_SESSION_ID } from '../../config.js';
import type { AppConfig, CurrentContext, InboundEvent } from '../../types.js';
import { contextFields, decodeStateRow, getStateDb } from './db.js';
import { stateDbPath } from './paths.js';

export function writeCurrentContext(config: AppConfig, event: InboundEvent): CurrentContext {
  const context: CurrentContext = {
    chatId: event.chatId,
    eventId: event.id,
    messageId: event.messageId,
    messageCreateTime: event.createTime,
    turnMessageId: event.messageId,
    threadId: event.threadId,
    source: event.source,
    kind: event.kind,
    textChars: event.text.length,
    startedAt: new Date().toISOString(),
    sendCount: 0,
  };
  const row = getStateDb(config)
    .prepare(`INSERT INTO current_context
    (singleton, chatId, eventId, messageId, messageCreateTime, turnMessageId, threadId, source, kind, textChars, startedAt, sendCount)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(singleton) DO UPDATE SET chatId=excluded.chatId, eventId=excluded.eventId,
      messageId=excluded.messageId, messageCreateTime=excluded.messageCreateTime,
      turnMessageId=excluded.turnMessageId, threadId=excluded.threadId,
      source=excluded.source, kind=excluded.kind,
      textChars=excluded.textChars, startedAt=excluded.startedAt, sendCount=0,
      lastSentAt=NULL, contextUsage=NULL, contextUsageSource=NULL RETURNING *`)
    .get(
      context.chatId,
      context.eventId,
      context.messageId ?? null,
      context.messageCreateTime ?? null,
      context.turnMessageId ?? null,
      context.threadId ?? null,
      context.source,
      context.kind,
      context.textChars,
      context.startedAt,
    );
  if (!row) throw new Error('current context upsert returned no row');
  return decodeStateRow<CurrentContext>(row, contextFields);
}

export function readCurrentContext(config: AppConfig): CurrentContext {
  const row = getStateDb(config).prepare('SELECT * FROM current_context WHERE singleton = 1').get();
  if (!row) throw new Error(`current message context not found: ${stateDbPath(config)}`);
  return decodeStateRow<CurrentContext>(row, contextFields);
}

/**
 * Moves only the staleness anchor forward; event identity, the turn's own message
 * and counters stay put, so the rest of a split reply still targets the right thread.
 */
export function advanceStalenessAnchor(
  config: AppConfig,
  reference: { messageId: string; messageCreateTime: number },
): CurrentContext {
  const row = getStateDb(config)
    .prepare(`UPDATE current_context SET messageId = ?, messageCreateTime = ?
    WHERE singleton = 1 AND (messageCreateTime IS NULL OR messageCreateTime <= ?) RETURNING *`)
    .get(reference.messageId, reference.messageCreateTime, reference.messageCreateTime);
  return row ? decodeStateRow<CurrentContext>(row, contextFields) : readCurrentContext(config);
}

export function recordContextSend(config: AppConfig, expectedEventId?: string): CurrentContext {
  const row = getStateDb(config)
    .prepare(`UPDATE current_context SET sendCount = sendCount + 1, lastSentAt = ?
    WHERE singleton = 1 ${expectedEventId === undefined ? '' : 'AND eventId = ?'} RETURNING *`)
    .get(new Date().toISOString(), ...(expectedEventId === undefined ? [] : [expectedEventId]));
  return updatedContext(config, row, expectedEventId);
}

export function recordContextUsage(
  config: AppConfig,
  usage: { text: string; source: string },
  expectedEventId?: string,
): CurrentContext {
  const row = getStateDb(config)
    .prepare(`UPDATE current_context SET contextUsage = ?, contextUsageSource = ?
    WHERE singleton = 1 ${expectedEventId === undefined ? '' : 'AND eventId = ?'} RETURNING *`)
    .get(usage.text, usage.source, ...(expectedEventId === undefined ? [] : [expectedEventId]));
  return updatedContext(config, row, expectedEventId);
}

function updatedContext(
  config: AppConfig,
  row: Record<string, unknown> | undefined,
  expectedEventId?: string,
): CurrentContext {
  if (row) return decodeStateRow<CurrentContext>(row, contextFields);
  const context = readCurrentContext(config);
  throw new Error(
    `current message context ownership changed: expected event ${expectedEventId}, current event ${context.eventId}`,
  );
}

/** The turn a CLI command was invoked from; absent outside a live turn. */
export function currentEventId(config: AppConfig): string | undefined {
  // The context stays persisted after a turn and every session's CLI reads the same
  // row, so only the main session's live turn can claim it. A child would otherwise
  // borrow whichever turn main is on, and a hand-run command the last one.
  if (process.env.RETRIEVER_SESSION_ID !== MAIN_SESSION_ID) return undefined;
  try {
    return readCurrentContext(config).eventId;
  } catch {
    return undefined;
  }
}
