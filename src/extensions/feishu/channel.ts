import type { ChannelAdapter } from '../../core/channels/registry.js';
import { ensureVisibleBinding, readVisibleBinding } from '../../core/state/binding.js';
import type { AppConfig, InboundEvent, Sender } from '../../types.js';
import { attachFeishuResources, pruneAttachments } from './attachments.js';
import { FeishuClient } from './client.js';
import { createSender } from './sender.js';
import { startFeishuWsReceiver } from './ws.js';

export class FeishuChannel implements ChannelAdapter {
  readonly type = 'feishu';
  readonly label = 'Feishu';
  readonly sender: Sender;
  private client: FeishuClient;
  private closed = false;
  private ws: Awaited<ReturnType<typeof startFeishuWsReceiver>> = null;

  constructor(private config: AppConfig) {
    // One client per channel keeps the tenant token warm for both directions.
    this.client = new FeishuClient(config.extensions.feishu);
    this.sender = createSender(config, this.client);
  }

  async start(onEvent: (event: InboundEvent) => Promise<void>): Promise<void> {
    if (this.closed) return;
    pruneAttachments(this.config);
    // Images and documents arrive as keys; they become local files before delivery.
    const ws = await startFeishuWsReceiver(this.config, async (event) =>
      onEvent(await attachFeishuResources(this.config, event, this.client)),
    );
    if (this.closed) ws?.close({ force: true });
    else this.ws = ws;
  }

  close(): void {
    this.closed = true;
    this.ws?.close({ force: true });
  }

  bindInbound(event: InboundEvent): void {
    if (
      event.kind !== 'message' ||
      !event.messageId ||
      !event.chatId ||
      !event.source.includes('feishu')
    )
      return;
    if (readVisibleBinding(this.config)) return;
    ensureVisibleBinding(this.config, event.chatId, 'auto');
    console.error(`[channel] feishu chat bound chat=${event.chatId}`);
  }

  dedupeKey(event: InboundEvent): string | null {
    if (event.kind !== 'message') return null;
    return event.messageId
      ? `message:${event.messageId}`
      : event.source.includes('feishu')
        ? `event:${event.id}`
        : null;
  }
}
