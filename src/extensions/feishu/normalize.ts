import { newId, normalizeInbound } from '../../core/events.js';
import type { InboundEvent } from '../../types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface FeishuMessage {
  message_id?: string;
  message_type?: string;
  create_time?: string;
  content?: unknown;
  chat_id?: string;
  /** `omt_*` in a topic group; absent on an ordinary message. */
  thread_id?: string;
}

interface FeishuSender {
  sender_type?: string;
  sender_id?: {
    open_id?: string;
    user_id?: string;
  };
}

interface FeishuEnvelope {
  id?: string;
  text?: string;
  prompt?: string;
  chatId?: string;
  message?: FeishuMessage;
  sender?: FeishuSender;
  event?: {
    message?: FeishuMessage;
    sender?: FeishuSender;
  };
  header?: {
    event_id?: string;
    event_type?: string;
  };
}

export function normalizeFeishuInbound(raw: unknown, source: string): InboundEvent {
  if (!raw || typeof raw !== 'object') return normalizeInbound(raw, source);
  const envelope = raw as FeishuEnvelope;

  const message = envelope.event?.message || envelope.message;
  const sender = envelope.event?.sender || envelope.sender;
  if (message) {
    return {
      id: envelope.header?.event_id || message.message_id || newId(),
      source,
      kind: 'message',
      chatId: message.chat_id || 'feishu-chat',
      userId: sender?.sender_id?.open_id || sender?.sender_id?.user_id,
      messageId: message.message_id,
      createTime: createTime(message),
      threadId: message.thread_id || undefined,
      text: messageText(message),
      raw,
    };
  }

  if (envelope.header?.event_id) {
    return {
      id: envelope.header.event_id,
      source,
      kind: 'message',
      chatId: envelope.chatId || 'unknown',
      text: envelope.text || envelope.prompt || '',
      raw,
    };
  }

  return normalizeInbound(raw, source);
}

/** Feishu reports creation time as a millisecond string; other shapes are ignored. */
export function createTime(message: { create_time?: string }): number | undefined {
  const value = Number(message.create_time);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function messageText(message: { message_type?: string; content?: unknown }): string {
  if (message.message_type === 'text' && typeof message.content === 'string') {
    try {
      const parsed = JSON.parse(message.content) as { text?: string };
      return parsed.text || message.content;
    } catch {
      return message.content;
    }
  }
  if (message.message_type === 'post' && typeof message.content === 'string') {
    try {
      const parsed = JSON.parse(message.content) as Record<string, unknown>;
      // Feishu nests rich text under a locale key: zh_cn, en_us, ja_jp.
      const locale = (Object.values(parsed).find(isRecord) ?? parsed) as {
        title?: string;
        content?: Array<Array<{ tag?: string; text?: string }>>;
      };
      // One array is one paragraph; keeping the rows apart is what makes several
      // images and their captions readable in order.
      const text = (locale.content ?? [])
        .map((row) =>
          row
            .map(
              (item) =>
                item.text ??
                (item.tag === 'img' ? '[image]' : item.tag === 'media' ? '[video]' : undefined),
            )
            .filter(Boolean)
            .join('')
            .trim(),
        )
        .filter(Boolean)
        .join('\n');
      // Files attached to a rich-text message sit beside the content, not in it.
      const files = postFiles(parsed).map((file) => `[file: ${file.name || 'unnamed'}]`);
      const body = [text, ...files].filter(Boolean).join('\n');
      return [locale.title, body].filter(Boolean).join('\n') || message.content;
    } catch {
      return message.content;
    }
  }
  if (typeof message.content !== 'string') return JSON.stringify(message.content ?? message);
  // Resources are described by a placeholder; the local file path arrives in the prompt.
  return placeholderText(message.message_type, message.content) ?? message.content;
}

/** A message body the agent can still interpret when the payload itself is not text. */
function placeholderText(messageType: string | undefined, content: string): string | undefined {
  if (messageType === 'image') return '[image]';
  if (messageType === 'file') return `[file: ${stringField(content, 'file_name') || 'unnamed'}]`;
  if (messageType === 'audio') return '[audio]';
  if (messageType === 'media') return '[video]';
  if (messageType === 'sticker') return '[sticker]';
  // A forwarded topic or merged forward: the body is a fixed placeholder and the
  // real transcript only exists behind the get-message API.
  if (messageType === 'merge_forward') return '[forwarded messages]';
  return undefined;
}

function stringField(content: string, field: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** An image or document key the channel has to fetch before the agent can see it. */
export interface MessageResource {
  kind: 'image' | 'file';
  key: string;
  name?: string;
}

export function messageResources(message: {
  message_type?: string;
  content?: unknown;
}): MessageResource[] {
  if (typeof message.content !== 'string') return [];
  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch {
    return [];
  }
  if (!isRecord(content)) return [];
  switch (message.message_type) {
    case 'image':
      return resource(content.image_key, 'image');
    case 'file':
      return resource(content.file_key, 'file', content.file_name);
    case 'post': {
      const locale = (Object.values(content).find(isRecord) ?? content) as { content?: unknown };
      const nodes = Array.isArray(locale.content) ? locale.content.flat() : [];
      const inline = nodes.flatMap((node) => {
        if (!isRecord(node)) return [];
        if (node.tag === 'img') return resource(node.image_key, 'image');
        return [];
      });
      return [...inline, ...postFiles(content).map((file) => file.resource)];
    }
    default:
      return [];
  }
}

function resource(key: unknown, kind: MessageResource['kind'], name?: unknown): MessageResource[] {
  if (typeof key !== 'string' || !key) return [];
  return [{ kind, key, name: typeof name === 'string' && name ? name : undefined }];
}

/** A rich-text message carries its attached documents in a sibling `files` array. */
function postFiles(content: Record<string, unknown>): Array<{
  resource: MessageResource;
  name?: string;
}> {
  const files = content.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.file_key !== 'string' || !entry.file_key) return [];
    const name =
      typeof entry.file_name === 'string' && entry.file_name ? entry.file_name : undefined;
    return [{ resource: { kind: 'file' as const, key: entry.file_key, name }, name }];
  });
}

/** One child message of a forwarded topic or merged forward, as the API returns it. */
export interface ForwardedMessage {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  body?: { content?: string };
  sender?: { id?: string; sender_type?: string };
  upper_message_id?: string;
}

/** The transcript the agent gets in place of the fixed "Merged and Forwarded Message". */
export function forwardedTranscript(children: ForwardedMessage[]): string {
  const lines = [`[forwarded ${children.length} messages]`];
  for (const [position, child] of children.entries()) {
    const text = messageText({ message_type: child.msg_type, content: child.body?.content })
      .replace(/\s+/g, ' ')
      .trim();
    const sender = child.sender?.sender_type === 'app' ? 'bot' : child.sender?.id || 'unknown';
    lines.push(`${position + 1}. ${sender}: ${text}`);
  }
  return lines.join('\n');
}
