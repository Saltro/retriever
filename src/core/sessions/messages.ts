import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../types.js';
import { getStateDb, stateTransaction } from '../state/db.js';

/**
 * Steering messages for a run in flight. The session owner reads them while the run
 * is live; a message belongs to one run token, so an edit cannot leak into the next
 * run of a stopped session.
 */
export interface SessionMessage {
  id: string;
  sessionId: string;
  runId: string;
  message: string;
  createdAt: string;
}

interface MessageRow {
  id: string;
  sessionId: string;
  runId: string;
  message: string;
  createdAt: string;
}

function toMessage(row: MessageRow): SessionMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId,
    message: row.message,
    createdAt: row.createdAt,
  };
}

export function enqueueSessionMessage(
  config: AppConfig,
  sessionId: string,
  runId: string,
  message: string,
  now = new Date(),
): SessionMessage {
  const record: SessionMessage = {
    id: randomUUID(),
    sessionId,
    runId,
    message: message.trim(),
    createdAt: now.toISOString(),
  };
  if (!record.message) throw new Error('session message must not be empty');
  getStateDb(config)
    .prepare(
      'INSERT INTO session_messages(id, sessionId, runId, message, createdAt, status) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(record.id, record.sessionId, record.runId, record.message, record.createdAt, 'pending');
  return record;
}

/** Oldest first: an agent that sent three notes gets them in the order it wrote them. */
export function pendingSessionMessages(
  config: AppConfig,
  sessionId: string,
  runId: string,
  limit = 10,
): SessionMessage[] {
  const rows = getStateDb(config)
    .prepare(
      `SELECT id, sessionId, runId, message, createdAt FROM session_messages
       WHERE sessionId = ? AND runId = ? AND status = 'pending'
       ORDER BY createdAt, id LIMIT ?`,
    )
    .all(sessionId, runId, limit) as unknown as MessageRow[];
  return rows.map(toMessage);
}

export function markSessionMessageDelivered(
  config: AppConfig,
  id: string,
  now = new Date(),
): boolean {
  const result = getStateDb(config)
    .prepare(
      "UPDATE session_messages SET status = 'delivered', deliveredAt = ? WHERE id = ? AND status = 'pending'",
    )
    .run(now.toISOString(), id);
  return Number(result.changes) > 0;
}

/** A run that ended leaves nothing to steer, so its leftovers never reach the next run. */
export function expireSessionMessages(
  config: AppConfig,
  sessionId: string,
  runId: string,
  now = new Date(),
): number {
  const db = getStateDb(config);
  return stateTransaction(db, () => {
    const result = db
      .prepare(
        "UPDATE session_messages SET status = 'expired', deliveredAt = ? WHERE sessionId = ? AND runId = ? AND status = 'pending'",
      )
      .run(now.toISOString(), sessionId, runId);
    return Number(result.changes);
  });
}
