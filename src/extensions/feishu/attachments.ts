import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../../core/state/paths.js';
import type { AppConfig, Attachment, InboundEvent } from '../../types.js';
import { FeishuClient, type FeishuTransport } from './client.js';
import {
  type ForwardedMessage,
  forwardedTranscript,
  type MessageResource,
  messageResources,
} from './normalize.js';

/** Chat attachments are for reading, not for archiving; a large file is refused. */
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;

/** Downloads outlive the conversation; the directory is pruned on daemon start. */
const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface RawMessage {
  message_id?: string;
  message_type?: string;
  content?: unknown;
}

interface Collected {
  attachments: Attachment[];
  failures: string[];
  nextIndex: number;
}

function emptyCollected(): Collected {
  return { attachments: [], failures: [], nextIndex: 0 };
}

function attachmentsDir(config: AppConfig): string {
  return path.join(stateDir(config), 'attachments');
}

/** Removes whole message directories older than the retention window. */
export function pruneAttachments(config: AppConfig, now = Date.now()): void {
  const root = attachmentsDir(config);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    try {
      if (now - fs.statSync(directory).mtimeMs < ATTACHMENT_RETENTION_MS) continue;
      fs.rmSync(directory, { recursive: true, force: true });
      console.error(`[feishu-attachment] pruned path=${directory}`);
    } catch (error) {
      console.error(
        `[feishu-attachment] prune failed path=${directory} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Turns a Feishu message into something the agent can act on: forwarded content
 * becomes text, and images and documents become local files it can open by path.
 * Anything that fails degrades to a note in the message text.
 */
export async function attachFeishuResources(
  config: AppConfig,
  event: InboundEvent,
  client: FeishuTransport = new FeishuClient(config.extensions.feishu),
): Promise<InboundEvent> {
  if (!event.raw || typeof event.raw !== 'object') return event;
  const envelope = event.raw as { event?: { message?: RawMessage }; message?: RawMessage };
  const message = envelope.event?.message || envelope.message;
  if (!message?.message_id) return event;

  const directory = path.join(attachmentsDir(config), safeName(message.message_id));
  let collected: Collected;
  let text = event.text;

  if (message.message_type === 'merge_forward') {
    const expanded = await expandForwarded(client, message.message_id, directory);
    // The event only carries "Merged and Forwarded Message"; the transcript replaces it.
    if (expanded.text) text = expanded.text;
    collected = expanded.collected;
  } else {
    collected = await collect(client, message.message_id, messageResources(message), directory, 0);
  }
  if (!collected.attachments.length && !collected.failures.length && text === event.text)
    return event;
  return {
    ...event,
    attachments: [...(event.attachments ?? []), ...collected.attachments],
    text: [text, ...collected.failures].filter(Boolean).join('\n'),
  };
}

/**
 * A forwarded topic or merged-forward message carries child messages that only
 * the get-message API returns.
 */
async function expandForwarded(
  client: FeishuTransport,
  messageId: string,
  directory: string,
): Promise<{ text?: string; collected: Collected }> {
  let items: ForwardedMessage[];
  try {
    const payload = await client.request<{ data?: { items?: ForwardedMessage[] } }>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
    );
    items = payload.data?.items ?? [];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[feishu-forward] unavailable message=${messageId} ${reason}`);
    return { text: '[forwarded messages: content unavailable]', collected: emptyCollected() };
  }
  const children = items
    .filter((item) => item.message_id && item.message_id !== messageId)
    .sort((a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0));
  if (!children.length)
    return { text: '[forwarded messages: none readable]', collected: emptyCollected() };

  const collected = emptyCollected();
  for (const child of children) {
    const resources = messageResources({
      message_type: child.msg_type,
      content: child.body?.content,
    });
    if (!resources.length) continue;
    // A forwarded child's resource is fetched through the container message id;
    // asking for it with the child's own id fails with "File not in msg".
    const childCollected = await collect(
      client,
      messageId,
      resources,
      directory,
      collected.nextIndex,
    );
    collected.attachments.push(...childCollected.attachments);
    collected.failures.push(...childCollected.failures);
    collected.nextIndex = childCollected.nextIndex;
  }
  return { text: forwardedTranscript(children), collected };
}

async function collect(
  client: FeishuTransport,
  messageId: string,
  resources: MessageResource[],
  directory: string,
  indexOffset: number,
): Promise<Collected> {
  const collected = emptyCollected();
  for (const [offset, resource] of resources.entries()) {
    const index = indexOffset + offset;
    try {
      collected.attachments.push(await download(client, messageId, resource, directory, index));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const label = `${resource.kind}${resource.name ? `: ${resource.name}` : ''}`;
      collected.failures.push(
        `[${label} ${reason.startsWith('too large') ? 'too large' : 'unavailable'}]`,
      );
      console.error(`[feishu-attachment] skipped message=${messageId} ${reason}`);
    }
  }
  collected.nextIndex = indexOffset + resources.length;
  return collected;
}

async function download(
  client: FeishuTransport,
  messageId: string,
  resource: MessageResource,
  directory: string,
  index: number,
): Promise<Attachment> {
  const buffer = await client.download(
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resource.key)}?type=${resource.kind}`,
    MAX_ATTACHMENT_BYTES,
  );
  if (buffer.length > MAX_ATTACHMENT_BYTES)
    throw new Error(`too large: ${buffer.length} bytes, limit ${MAX_ATTACHMENT_BYTES}`);
  fs.mkdirSync(directory, { recursive: true });
  const name = resource.name || `image-${index + 1}${imageExtension(buffer)}`;
  const file = path.join(directory, `${index + 1}-${safeName(name)}`);
  fs.writeFileSync(file, buffer);
  console.error(
    `[feishu-attachment] saved message=${messageId} path=${file} bytes=${buffer.length}`,
  );
  return { kind: resource.kind, path: file, name };
}

function safeName(value: string): string {
  const name = path.basename(value).replace(/[^\p{L}\p{N}._-]+/gu, '_');
  return name && name !== '.' && name !== '..' ? name.slice(0, 120) : 'attachment';
}

/** Feishu image keys carry no extension, and the agent reads images by path. */
function imageExtension(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return '.png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return '.jpg';
  if (buffer.subarray(0, 4).toString() === 'GIF8') return '.gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP')
    return '.webp';
  return '.img';
}
