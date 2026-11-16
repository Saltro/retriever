/** Internal test-only surface: a mock sender captures outbound replies. */
export interface SenderConfig {
  type: string;
  mockOutbox: string;
}

export interface ExtensionsConfig {
  pi: PiExtensionConfig;
  feishu: FeishuExtensionConfig;
}

export interface PiExtensionConfig {
  bin: string;
  extraArgs: string[];
  sessionDir?: string;
  timeoutMs?: number;
}

export interface FeishuExtensionConfig {
  appId: string;
  appSecret: string;
}

interface AgentProfileBase {
  cwd?: string;
  sessionDir?: string;
}

export interface PiAgentProfile extends AgentProfileBase {
  backend: 'pi';
  bin?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export interface MockAgentProfile extends AgentProfileBase {
  backend: 'mock';
  replyPrefix?: string;
}

/** A plain-text process, not a Pi RPC/print-compatible executable. */
export interface ProcessAgentProfile extends AgentProfileBase {
  backend: 'process';
  command: string;
  args?: string[];
  promptMode?: 'stdin' | 'argument';
  timeoutMs?: number;
  env?: Record<string, string>;
}

export type AgentProfile = PiAgentProfile | MockAgentProfile | ProcessAgentProfile;

export interface AppConfig {
  workspaceDir: string;
  agentProfiles?: Record<string, AgentProfile>;
  channel?: { type: string };
  extensions: ExtensionsConfig;
  stateDir?: string;
  /** Internal: resolved config file path used to resolve relative paths. */
  configPath?: string;
  /** Internal: test-only outbound capture. */
  sender?: SenderConfig;
}

/** An image or document moved out of the chat and onto this machine. */
export interface Attachment {
  kind: 'image' | 'file';
  /** Absolute local path the agent can read. */
  path: string;
  name?: string;
}

export interface InboundEvent {
  id: string;
  source: string;
  kind: 'message' | 'wake';
  chatId: string;
  userId?: string;
  messageId?: string;
  /** Platform creation time in epoch milliseconds, when the channel provides one. */
  createTime?: number;
  /** Topic thread the message belongs to; only platforms with topics set it. */
  threadId?: string;
  text: string;
  /** Resources the channel downloaded for this message, in arrival order. */
  attachments?: Attachment[];
  /**
   * Set by producers whose event carries its own semantics (scheduled wake, child completion).
   * Plain channel messages leave it empty and get framed with the channel label instead.
   */
  prompt?: string;
  raw?: unknown;
}

/**
 * Where a reply belongs inside a thread. `id` names the thread; `anchorMessageId`
 * names the message the reply hangs off, because some platforms accept only a
 * message id and cannot address a thread directly.
 */
export interface ReplyThread {
  /** Platform thread identity, e.g. a Feishu topic id (`omt_*`). */
  id: string;
  /** Message inside the thread that carries the reply. */
  anchorMessageId: string;
}

export interface OutboundReply {
  chatId: string;
  inReplyTo: string;
  /** Absent means the reply belongs in the chat stream. */
  thread?: ReplyThread;
  text: string;
  contextFooter?: string;
  /** Long output arrives as a card; a normal reply stays a plain chat message. */
  long?: boolean;
}

/** A recently received message, as the platform reports it. */
export interface RecentMessage {
  messageId: string;
  /** Platform creation time in epoch milliseconds. */
  createTime: number;
  text: string;
  userId?: string;
  /** True when this account sent it, so it never counts as an unanswered message. */
  fromSelf?: boolean;
}

export interface Sender {
  send(reply: OutboundReply): Promise<unknown>;
  /** One image or document per message; the chat platform decides how it renders. */
  sendAttachment?(
    chatId: string,
    attachment: Attachment,
    options?: { thread?: ReplyThread },
  ): Promise<unknown>;
  addReaction?(messageId: string, emojiType: string): Promise<unknown>;
  /** Newest messages in the chat, for detecting that a reply is behind the conversation. */
  recentMessages?(chatId: string, limit: number): Promise<RecentMessage[]>;
}

export interface CurrentContext {
  chatId: string;
  eventId: string;
  /**
   * Staleness anchor: the newest message this turn is known to have accounted
   * for. `--rebase`/`--force` move it forward, so it is not the reply target.
   */
  messageId?: string;
  /** Creation time of `messageId`, in epoch milliseconds. */
  messageCreateTime?: number;
  /**
   * The message that started this turn, kept apart from the staleness anchor so a
   * `--rebase`/`--force` reply still targets the message the user sent.
   */
  turnMessageId?: string;
  /** Set when the event came from a topic thread, so replies stay in it. */
  threadId?: string;
  source: string;
  kind: InboundEvent['kind'];
  textChars: number;
  startedAt: string;
  sendCount: number;
  lastSentAt?: string;
  contextUsage?: string;
  contextUsageSource?: string;
}
