import type { InboundEvent } from '../types.js';
import { joinBlocks, responseInstructions } from './instructions.js';
import { localTimestamp } from './time.js';
import { element, promptBody } from './xml.js';

export function aggregatedMessagesPrompt(
  events: InboundEvent[],
  channelLabel: string,
  isMainSession: boolean,
  receivedAt: Date = new Date(),
): string {
  const messages = events
    .map((event, index) =>
      element('message', { index: index + 1, source: event.source }, promptBody(event.text)),
    )
    .join('\n');
  return joinBlocks([
    element(
      'inbound-messages',
      { channel: channelLabel, count: events.length, received_at: localTimestamp(receivedAt) },
      messages,
    ),
    responseInstructions({ isMainSession }),
  ]);
}
