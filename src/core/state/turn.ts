import type { AppConfig, InboundEvent } from '../../types.js';
import { getStateDb, readStateMeta, writeStateMeta } from './db.js';

const PENDING_TURN_KEY = 'pending-turn';

/**
 * A main turn in flight. The record outlives a daemon that is stopped or killed
 * before the turn ends, so the next start finishes the work instead of losing it.
 */
export interface PendingTurn {
  event: InboundEvent;
  /** Prompt without the runtime contract, so recovery wraps it exactly once. */
  message: string;
  /** Messages steered into this turn, in arrival order; they replay with it. */
  steers: string[];
  startedAt: string;
  attempts: number;
}

export function writePendingTurn(config: AppConfig, turn: PendingTurn): void {
  // The channel payload is only useful while the event is being handled.
  const { raw: _raw, ...event } = turn.event;
  writeStateMeta(getStateDb(config), PENDING_TURN_KEY, JSON.stringify({ ...turn, event }));
}

export function readPendingTurn(config: AppConfig): PendingTurn | undefined {
  const stored = readStateMeta(getStateDb(config), PENDING_TURN_KEY);
  if (!stored) return undefined;
  try {
    const turn = JSON.parse(stored) as Partial<PendingTurn>;
    if (!turn.event?.id || typeof turn.message !== 'string' || typeof turn.startedAt !== 'string')
      throw new Error('incomplete pending turn');
    return {
      event: turn.event,
      message: turn.message,
      steers: Array.isArray(turn.steers) ? turn.steers.filter((s) => typeof s === 'string') : [],
      startedAt: turn.startedAt,
      attempts: Number.isSafeInteger(turn.attempts) ? Number(turn.attempts) : 0,
    };
  } catch {
    // A record this broken cannot describe a turn; drop it rather than block startup.
    clearPendingTurn(config);
    return undefined;
  }
}

export function clearPendingTurn(config: AppConfig): void {
  getStateDb(config).prepare('DELETE FROM state_meta WHERE key = ?').run(PENDING_TURN_KEY);
}
