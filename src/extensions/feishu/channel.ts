import type { ChannelAdapter } from '../../core/channels/registry.js';
import { ensureFeishuChatBinding, readFeishuChatBinding } from '../../core/state/binding.js';
import type { AppConfig, InboundEvent, Sender } from '../../types.js';
import { attachFeishuResources } from './attachments.js';
import { createSender } from './sender.js';
import { startFeishuWsReceiver } from './ws.js';

export class FeishuChannel implements ChannelAdapter {
  readonly type = 'feishu';
  readonly label = 'Feishu';
  readonly sender: Sender;
  private closed = false;
  private ws: Awaited<ReturnType<typeof startFeishuWsReceiver>> = null;

  constructor(private config: AppConfig) {
    this.sender = createSender(config);
  }

  async start(onEvent: (event: InboundEvent) => Promise<void>): Promise<void> {
    if (this.closed) return;
    // Images and documents arrive as keys; they become local files before delivery.
    const ws = await startFeishuWsReceiver(this.config, async (event) =>
      onEvent(await attachFeishuResources(this.config, event)),
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
    if (readFeishuChatBinding(this.config)) return;
    ensureFeishuChatBinding(this.config, event.chatId, 'auto');
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
