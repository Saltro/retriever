import type { InboundEvent } from '../types.js';
import { joinBlocks, responseInstructions } from './instructions.js';
import { localTimestamp } from './time.js';
import { element, promptBody } from './xml.js';

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
      { channel: channelLabel, source: event.source, received_at: localTimestamp(receivedAt) },
      promptBody(event.text),
    ),
    responseInstructions({ isMainSession }),
  ]);
}
