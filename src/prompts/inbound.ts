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
