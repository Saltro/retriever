import fs from 'node:fs';
import path from 'node:path';
import type {
  AppConfig,
  Attachment,
  FeishuExtensionConfig,
  OutboundReply,
  RecentMessage,
  Sender,
  SenderConfig,
} from '../../types.js';
import { type FeishuApiResponse, FeishuClient, type FeishuTransport } from './client.js';
import { createTime, messageText } from './normalize.js';

export class MockSender implements Sender {
  private outbox: string;

  constructor(config: SenderConfig) {
    this.outbox = config.mockOutbox;
    fs.mkdirSync(path.dirname(this.outbox), { recursive: true });
  }

  async send(reply: OutboundReply): Promise<{ ok: true; mock: true }> {
    const record = {
      ...reply,
      msgType: reply.long ? 'interactive' : 'post',
      card: buildReplyCard(reply),
      post: buildReplyPost(reply),
      sentAt: new Date().toISOString(),
      transport: 'mock',
    };
    fs.appendFileSync(this.outbox, `${JSON.stringify(record)}\n`);
    console.error(
      `[mock-send] chat=${reply.chatId} msgType=${record.msgType} markdown=${JSON.stringify(reply.text)} footer=${JSON.stringify(reply.contextFooter || '')}`,
    );
    return { ok: true, mock: true };
  }

  async sendAttachment(
    chatId: string,
    attachment: Attachment,
    options: { threadMessageId?: string } = {},
  ): Promise<{ ok: true; mock: true }> {
    const record = {
      chatId,
      msgType: attachment.kind,
      attachment,
      threadMessageId: options.threadMessageId,
      sentAt: new Date().toISOString(),
      transport: 'mock-attachment',
    };
    fs.appendFileSync(this.outbox, `${JSON.stringify(record)}\n`);
    console.error(
      `[mock-send] chat=${chatId} msgType=${attachment.kind} path=${attachment.path} name=${attachment.name || ''} thread=${options.threadMessageId || ''}`,
    );
    return { ok: true, mock: true };
  }

  /** Reads `<outbox>.recent` so tests can script the chat's current message list. */
  async recentMessages(): Promise<RecentMessage[]> {
    const file = `${this.outbox}.recent`;
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RecentMessage);
  }

  async addReaction(messageId: string, emojiType: string): Promise<{ ok: true; mock: true }> {
    const record = {
      messageId,
      emojiType,
      sentAt: new Date().toISOString(),
      transport: 'mock-reaction',
    };
    fs.appendFileSync(this.outbox, `${JSON.stringify(record)}\n`);
    console.error(`[mock-reaction] message=${messageId} emoji=${emojiType}`);
    return { ok: true, mock: true };
  }
}

interface FeishuListedMessage {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  content?: unknown;
  body?: { content?: string };
  sender?: { id?: string; sender_type?: string };
}

/** A hung connection must not hold up a reply; the caller falls back to sending. */
const LIST_TIMEOUT_MS = 3000;

/** Feishu caps an image message at 10 MB and a file message at 30 MB. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

export class FeishuSender implements Sender {
  private client: FeishuTransport;

  constructor(
    private config: FeishuExtensionConfig,
    client: FeishuTransport = new FeishuClient(config),
  ) {
    this.client = client;
  }

  async send(reply: OutboundReply): Promise<FeishuApiResponse> {
    return this.sendMessage(
      reply.long ? 'interactive' : 'post',
      reply.long ? buildReplyCard(reply) : buildReplyPost(reply),
      { chatId: reply.chatId, threadMessageId: reply.threadMessageId },
    );
  }

  /** Feishu carries one resource per message, so each attachment is its own send. */
  async sendAttachment(
    chatId: string,
    attachment: Attachment,
    options: { threadMessageId?: string } = {},
  ): Promise<FeishuApiResponse> {
    const name = attachment.name || path.basename(attachment.path);
    const limit = attachment.kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    const size = fs.statSync(attachment.path).size;
    if (size > limit)
      throw new Error(
        `${name} is ${size} bytes; Feishu accepts at most ${limit} for a${attachment.kind === 'image' ? 'n image' : ' file'} message`,
      );
    const data = fs.readFileSync(attachment.path);
    if (attachment.kind === 'file' && !path.extname(name))
      throw new Error(`${name} has no file extension; Feishu requires one`);
    const target = { chatId, threadMessageId: options.threadMessageId };
    if (attachment.kind === 'image') {
      const form = new FormData();
      form.append('image_type', 'message');
      form.append('image', fileBlob(data), name);
      const uploaded = await this.client.upload('/open-apis/im/v1/images', form);
      return this.sendMessage(
        'image',
        { image_key: (uploaded.data as { image_key?: string } | undefined)?.image_key },
        target,
      );
    }
    const form = new FormData();
    form.append('file_type', 'stream');
    form.append('file_name', name);
    form.append('file', fileBlob(data), name);
    const uploaded = await this.client.upload('/open-apis/im/v1/files', form);
    return this.sendMessage(
      'file',
      { file_key: (uploaded.data as { file_key?: string } | undefined)?.file_key },
      target,
    );
  }

  async addReaction(messageId: string, emojiType: string): Promise<FeishuApiResponse> {
    return this.client.request(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      { json: { reaction_type: { emoji_type: emojiType } } },
    );
  }

  async recentMessages(chatId: string, limit: number): Promise<RecentMessage[]> {
    const query = new URLSearchParams({
      container_id_type: 'chat',
      container_id: chatId,
      sort_type: 'ByCreateTimeDesc',
      page_size: String(Math.min(Math.max(limit, 1), 50)),
    });
    const body = await this.client.request<FeishuApiResponse>(
      `/open-apis/im/v1/messages?${query}`,
      { timeoutMs: LIST_TIMEOUT_MS },
    );
    const items = (body.data as { items?: FeishuListedMessage[] } | undefined)?.items || [];
    return items.flatMap((item) => {
      const create = createTime(item);
      if (!item.message_id || create === undefined) return [];
      return [
        {
          messageId: item.message_id,
          createTime: create,
          text: messageText({ message_type: item.msg_type, content: item.body?.content }),
          userId: item.sender?.id,
          // Only this app's own messages are self; another bot can still interrupt.
          fromSelf:
            item.sender?.sender_type === 'app' &&
            (!this.config.appId || item.sender.id === this.config.appId),
        },
      ];
    });
  }

  private async sendMessage(
    msgType: string,
    content: Record<string, unknown>,
    target: { chatId: string; threadMessageId?: string },
  ): Promise<FeishuApiResponse> {
    // A topic group takes a top-level send as a new topic, so an answer to a topic
    // message has to arrive as a reply inside that thread.
    if (target.threadMessageId)
      return this.client.request(
        `/open-apis/im/v1/messages/${encodeURIComponent(target.threadMessageId)}/reply`,
        { json: { msg_type: msgType, content: JSON.stringify(content), reply_in_thread: true } },
      );
    return this.client.request('/open-apis/im/v1/messages?receive_id_type=chat_id', {
      json: { receive_id: target.chatId, msg_type: msgType, content: JSON.stringify(content) },
    });
  }
}

function fileBlob(data: Buffer): Blob {
  return new Blob([new Uint8Array(data)]);
}

/**
 * A normal reply is a chat message: rendered from markdown, with the context
 * estimate as an italic last line instead of a card footer.
 */
function buildReplyPost(reply: OutboundReply): Record<string, unknown> {
  const footer = reply.contextFooter?.trim();
  // A star inside the footer would close the emphasis early.
  const text = footer ? `${reply.text}\n\n*${footer.replace(/\*/g, '')}*` : reply.text;
  return { zh_cn: { content: [[{ tag: 'md', text }]] } };
}

function buildReplyCard(reply: OutboundReply): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [{ tag: 'markdown', content: reply.text }];
  if (reply.contextFooter) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: reply.contextFooter,
        text_size: 'notation',
        text_color: 'grey',
      },
    });
  }
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    body: { direction: 'vertical', elements },
  };
}

export function createSender(config: AppConfig, client?: FeishuTransport): Sender {
  if (config.sender?.type === 'mock') return new MockSender(config.sender);
  return new FeishuSender(config.extensions.feishu, client);
}
