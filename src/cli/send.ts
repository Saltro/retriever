import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { createChannelAdapter } from '../core/channels/registry.js';
import {
  newestUnreadAnchor,
  RECENT_MESSAGE_WINDOW,
  unreadMessages,
} from '../core/channels/staleness.js';
import { readVisibleBinding as readOutputBinding } from '../core/state/binding.js';
import {
  advanceContextAnchor,
  readCurrentContext,
  recordContextSend,
} from '../core/state/context.js';
import type { Attachment, CurrentContext, RecentMessage, ReplyThread } from '../types.js';

/** Long enough for a chat-style reply, short enough to keep the conversation readable. */
export const CHAT_REPLY_LIMIT = 200;

export function sendUsage(command = 'retriever send'): never {
  console.error(`Usage: ${command} [--long] [--rebase|--force] <text...> | --stdin
       ${command} [--image <path>] [--file <path>]... [--long] [--rebase|--force] [<text...>]

The default reply is a chat message of at most ${CHAT_REPLY_LIMIT} characters.
Split longer answers into a few sends, or pass --long for code, tables or
anything that has to arrive as one message.

--image and --file upload a local file and send it as its own message; repeat
the flag for several, and add text for a caption.

--rebase  newer messages arrived; this text already accounts for them
--force   newer messages arrived; they do not affect this reply`);
  process.exit(2);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runSendCli(args: string[], command = 'retriever send'): Promise<void> {
  const long = args.includes('--long');
  const rebase = args.includes('--rebase');
  const force = args.includes('--force');
  const words: string[] = [];
  const attachments: Attachment[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--image' || arg === '--file') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) sendUsage(command);
      index += 1;
      const file = path.resolve(value);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        console.error(`[${command}] not sent: ${file} is not a readable file`);
        process.exit(2);
      }
      attachments.push({ kind: arg === '--image' ? 'image' : 'file', path: file });
    } else if (!['--long', '--rebase', '--force'].includes(arg)) {
      words.push(arg);
    }
  }
  const stdin = words.includes('--stdin');
  const inline = words.filter((word) => word !== '--stdin');
  if (stdin && inline.length) sendUsage(command);
  const text = (stdin ? await readStdin() : inline.join(' ')).trim();

  if (!text && !attachments.length) sendUsage(command);
  const length = [...text].length;
  if (text && !long && length > CHAT_REPLY_LIMIT) {
    console.error(
      `[${command}] not sent: ${length} characters exceeds the ${CHAT_REPLY_LIMIT}-character chat limit.\n` +
        'Split it into a few shorter sends the way you would in a conversation,\n' +
        'or pass --long for code, markdown or anything that does not fit a chat bubble.',
    );
    process.exit(2);
  }

  const config = loadConfig();
  const channel = createChannelAdapter(config);
  const binding = readOutputBinding(config);
  if (!binding && channel.type !== 'stdin')
    throw new Error(
      'Output destination is not bound. Run: retriever bind destination --chat-id <chat_id>',
    );
  const chatId = binding?.chatId || 'stdin';
  const context = tryReadCurrentContext(config);
  if (context)
    await guardConversation(config, channel, chatId, context, { rebase, force }, command);
  const thread = replyThread(context, chatId);
  if (text || !attachments.length)
    await sendText(config, channel, chatId, context, text, long, thread, command);
  for (const attachment of attachments) {
    const sendAttachment = channel.sender.sendAttachment;
    if (!sendAttachment)
      throw new Error(`Channel ${channel.type} cannot send ${attachment.kind} messages.`);
    await sendAttachment.call(channel.sender, chatId, attachment, { thread });
    console.error(
      `[${command}] sent ${attachment.kind} chat=${chatId} path=${attachment.path} name=${attachment.name || path.basename(attachment.path)}`,
    );
  }
  // A reply made only of attachments still ends the turn.
  if (!text && context) recordSend(config, context, chatId, command);
}

async function sendText(
  config: ReturnType<typeof loadConfig>,
  channel: ReturnType<typeof createChannelAdapter>,
  chatId: string,
  context: CurrentContext | undefined,
  text: string,
  long: boolean,
  thread: ReplyThread | undefined,
  command: string,
): Promise<void> {
  await channel.sender.send({
    chatId,
    inReplyTo: context?.eventId || 'manual',
    thread,
    text,
    contextFooter: context?.contextUsage,
    long,
  });
  if (context) recordSend(config, context, chatId, command);
  else console.error(`[${command}] sent event=manual chat=${chatId}`);
}

function recordSend(
  config: ReturnType<typeof loadConfig>,
  context: CurrentContext,
  chatId: string,
  command: string,
): void {
  try {
    const updated = recordContextSend(config, context.eventId);
    console.error(
      `[${command}] sent event=${updated.eventId} chat=${chatId} count=${updated.sendCount}`,
    );
  } catch (error) {
    console.error(
      `[${command}] sent event=${context.eventId} chat=${chatId}; context accounting warning: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Refuses a reply that is behind the conversation, or records that the newer
 * messages are accounted for when the caller says so.
 */
async function guardConversation(
  config: ReturnType<typeof loadConfig>,
  channel: ReturnType<typeof createChannelAdapter>,
  chatId: string,
  context: CurrentContext,
  flags: { rebase: boolean; force: boolean },
  command: string,
): Promise<void> {
  const list = channel.sender.recentMessages;
  // The check depends on platform ordering; without it, sending must still work.
  if (!list || context.messageCreateTime === undefined) return;
  let recent: RecentMessage[];
  try {
    recent = await list.call(channel.sender, chatId, RECENT_MESSAGE_WINDOW);
  } catch (error) {
    console.error(
      `[${command}] staleness check skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const unread = unreadMessages(context, recent);
  if (!unread.length) return;
  if (flags.rebase || flags.force) {
    const newest = newestUnreadAnchor(unread);
    if (newest)
      advanceContextAnchor(config, {
        messageId: newest.messageId,
        messageCreateTime: newest.createTime,
      });
    return;
  }
  const lines = unread
    .sort((a, b) => a.createTime - b.createTime)
    .map((message) => {
      const who = message.userId ? `${message.userId} ` : '';
      return `  ${who}${new Date(message.createTime).toLocaleTimeString()}  ${message.text.replace(/\s+/g, ' ').slice(0, 300)}`;
    });
  console.error(
    [
      `[${command}] not sent: ${unread.length} message(s) arrived after this turn started.`,
      ...lines,
      '',
      '  incorporate them and send again:',
      `    ${command} --rebase --stdin`,
      '  or send this reply as written:',
      `    ${command} --force --stdin`,
    ].join('\n'),
  );
  process.exit(3);
}

/**
 * A threaded reply hangs off the message that started the turn — not the staleness
 * anchor, which moves forward — and only when that thread lives in the bound chat:
 * a thread from another input chat must not pull the visible destination with it.
 */
function replyThread(context: CurrentContext | undefined, chatId: string): ReplyThread | undefined {
  if (!context?.threadId || !context.turnMessageId || context.chatId !== chatId) return undefined;
  return { id: context.threadId, anchorMessageId: context.turnMessageId };
}

function tryReadCurrentContext(config: ReturnType<typeof loadConfig>) {
  try {
    return readCurrentContext(config);
  } catch (error) {
    if (error instanceof Error && error.message.includes('current message context not found'))
      return undefined;
    throw error;
  }
}
