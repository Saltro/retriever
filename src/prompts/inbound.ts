import type { InboundEvent } from '../types.js';
import { joinBlocks, responseInstructions } from './instructions.js';
import { localTimestamp } from './time.js';
import { element, inlineElement, promptBody } from './xml.js';

/** Frames a channel message; the channel only supplies its display label. */
export function inboundMessagePrompt(
  event: InboundEvent,
  channelLabel: string,
  isMainSession: boolean,
  receivedAt: Date = new Date(),
): string {
  return joinBlocks([
    element(
      'inbound-message',
      {
        channel: channelLabel,
        source: event.source,
        thread: event.threadId,
        received_at: localTimestamp(receivedAt),
      },
      [promptBody(event.text), ...attachmentElements(event)].filter(Boolean).join('\n'),
    ),
    responseInstructions({ isMainSession }),
  ]);
}

export interface ResumedTurnOptions {
  /** When the interrupted attempt began. */
  startedAt: string;
  channel?: string;
  /** Messages steered into the interrupted turn, in arrival order. */
  steers?: string[];
  resumedAt?: Date;
}

/**
 * A turn the daemon lost mid-flight. The original prompt is repeated verbatim, so
 * the agent finishes the request even when its own transcript stops mid-turn.
 */
export function resumedTurnPrompt(
  originalMessage: string,
  { startedAt, channel, steers = [], resumedAt = new Date() }: ResumedTurnOptions,
): string {
  return joinBlocks([
    element(
      'resumed-turn',
      {
        channel,
        attempt_started_at: localTimestamp(new Date(startedAt)),
        resumed_at: localTimestamp(resumedAt),
        steered_messages: steers.length || undefined,
        reason:
          'retriever terminated while this turn was still running: a restart, an unexpected shutdown, or a crash',
      },
      [
        'This attempt ended mid-turn with no reply confirmed for the user, and your transcript may break off inside it. Retriever is running again and resumes the same turn with the original request below.',
        '',
        'Finish it now: continue from what this session shows, verify whatever the interrupted attempt already did, and send something new rather than repeating a message the user may already have.',
      ].join('\n'),
    ),
    originalMessage,
    steers.length
      ? element(
          'steered-messages',
          { count: steers.length },
          [
            'These messages also arrived before the interruption and belong to the same turn.',
            ...steers,
          ].join('\n\n'),
        )
      : undefined,
  ]);
}

/** A downloaded image or document is only useful to the agent as a local path. */
function attachmentElements(event: InboundEvent): string[] {
  return (event.attachments ?? []).map((attachment) =>
    inlineElement(
      'attachment',
      { kind: attachment.kind, name: attachment.name, path: attachment.path },
      'already downloaded to this machine',
    ),
  );
}
