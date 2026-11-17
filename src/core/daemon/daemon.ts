import { inboundMessagePrompt, resumedTurnPrompt } from '../../prompts/inbound.js';
import { isSilenceReply, SILENCE_TOKEN } from '../../prompts/instructions.js';
import { withContract } from '../../prompts/system.js';
import type { AppConfig, InboundEvent } from '../../types.js';
import { type AgentRunner, createMainAgentRunner } from '../agents/registry.js';
import { type ChannelAdapter, createChannelAdapter } from '../channels/registry.js';
import { RuntimeCronDispatcher } from '../cron/dispatch.js';
import { logEvent } from '../log.js';
import {
  acknowledgeParentNotification,
  claimParentNotifications,
  noticeToInbound,
  recoverParentNotifications,
  releaseParentNotification,
} from '../sessions/callbacks.js';
import { readCurrentContext, recordContextUsage, writeCurrentContext } from '../state/context.js';
import { clearPendingTurn, readPendingTurn, writePendingTurn } from '../state/turn.js';

export interface DaemonOptions {
  runner?: AgentRunner;
  channel?: ChannelAdapter;
}

const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MAX_KEYS = 1000;
const PROCESSING_REACTION = 'OK';
const COMPLETION_REACTION = 'DONE';
/** A turn that dies with its daemon is retried this many times before it is dropped. */
const MAX_TURN_RECOVERIES = 2;

export class PersonalDaemon {
  private runner: AgentRunner;
  private channel: ChannelAdapter;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private callbacksRecovered = false;
  private callbackDeliveryScheduled = false;
  private runtimeCron: RuntimeCronDispatcher;
  private callbackPoller: NodeJS.Timeout | null = null;
  private seenInbound = new Map<string, number>();

  constructor(
    private config: AppConfig,
    options: DaemonOptions = {},
  ) {
    this.runner = options.runner || createMainAgentRunner(config);
    this.channel = options.channel || createChannelAdapter(config);
    this.runtimeCron = new RuntimeCronDispatcher(config, (event) => this.enqueue(event));
  }

  start(): void {
    this.runner.start();
    // Recovery goes first so no producer can claim the record with a fresh turn.
    this.resumeInterruptedTurn();
    this.channel
      .start((event) => this.enqueue(event))
      .catch((error) =>
        logEvent(this.config, 'channel', 'start.failed', { error: describeError(error) }),
      );
    this.runtimeCron.start();
    this.startCallbackPoller();
  }

  /**
   * A turn the previous process lost mid-flight is the only record of work the user
   * asked for, so hand it back to the agent instead of waiting for a new message.
   */
  private resumeInterruptedTurn(): void {
    const pending = readPendingTurn(this.config);
    if (!pending) return;
    const attempts = pending.attempts + 1;
    if (attempts > MAX_TURN_RECOVERIES) {
      clearPendingTurn(this.config);
      logEvent(this.config, 'daemon', 'turn.recovery.dropped', {
        event_id: pending.event.id,
        attempts: pending.attempts,
      });
      return;
    }
    writePendingTurn(this.config, { ...pending, attempts });
    logEvent(this.config, 'daemon', 'turn.recovery.start', {
      event_id: pending.event.id,
      attempts,
      started_at: pending.startedAt,
    });
    this.enqueue({
      ...pending.event,
      prompt: resumedTurnPrompt(pending.message, {
        startedAt: pending.startedAt,
        channel: this.channel.label,
        steers: pending.steers,
      }),
    }).catch((error) =>
      logEvent(this.config, 'daemon', 'turn.recovery.failed', {
        event_id: pending.event.id,
        error: describeError(error),
      }),
    );
  }

  enqueue(event: InboundEvent): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Daemon is stopped'));
    if (event.source !== 'session-callback') this.deliverCallbackNotifications();
    const dedupeKey = this.dedupeKey(event);
    if (dedupeKey && this.isDuplicate(dedupeKey)) {
      logEvent(this.config, 'daemon', 'event.duplicate', { event_id: event.id, key: dedupeKey });
      return this.queue;
    }
    // A user message interrupts the running turn; wakes and callbacks wait their turn.
    if (event.kind === 'message' && this.runner.isRunning() && this.runner.capabilities.steer) {
      this.steerActiveRun(event).catch(async (error) => {
        if (dedupeKey) this.seenInbound.delete(dedupeKey);
        logEvent(this.config, 'daemon', 'steer.failed', {
          event_id: event.id,
          error: describeError(error),
        });
        // The runner is still busy, so a plain enqueue would be rejected and lost.
        await this.runner.waitForSettled().catch(() => undefined);
        void this.enqueueImmediate(event, dedupeKey).catch(() => undefined);
      });
      return this.queue;
    }
    return this.enqueueImmediate(event, dedupeKey);
  }

  private enqueueImmediate(
    event: InboundEvent,
    dedupeKeys: string | string[] | null = null,
  ): Promise<void> {
    const keys = Array.isArray(dedupeKeys) ? dedupeKeys : dedupeKeys ? [dedupeKeys] : [];
    const task = this.queue.then(async () => {
      if (this.stopped) throw new Error('Daemon stopped before event delivery');
      await this.handleEvent(event);
    });
    this.queue = task.catch((error) => {
      for (const key of keys) this.seenInbound.delete(key);
      logEvent(this.config, 'daemon', 'event.failed', {
        event_id: event.id,
        error: describeError(error),
      });
    });
    return task;
  }

  private messageFor(event: InboundEvent): string {
    return event.prompt ?? inboundMessagePrompt(event, this.channel.label, true);
  }

  private async steerActiveRun(event: InboundEvent): Promise<void> {
    const startedAt = Date.now();
    logEvent(this.config, 'daemon', 'steer.start', {
      event_id: event.id,
      text_chars: event.text.length,
    });
    this.channel.bindInbound(event);
    await this.addReaction(event, PROCESSING_REACTION, 'processing');
    const message = this.messageFor(event);
    const response = await this.runner.steer(withContract(this.config, 'main', message));
    // A queued steer is delivered before the next model call. Until then the agent may
    // still be composing from the older message, so the anchor stays put and `send`
    // refuses once; --rebase/--force then advances it.
    if (response.disposition !== 'queued') writeCurrentContext(this.config, event);
    this.recordSteer(message);
    logEvent(this.config, 'daemon', 'steer.queued', {
      event_id: event.id,
      disposition: response.disposition,
    });
    this.runner
      .waitForSettled()
      .then(async () => {
        await this.refreshContextUsage(event.id);
        const context = readCurrentContext(this.config);
        const sends = context.sendCount || 0;
        logEvent(this.config, 'decision', 'turn.end', {
          event_id: event.id,
          kind: event.kind,
          steered: true,
          sends,
          ms: Date.now() - startedAt,
        });
        if (!sends)
          logEvent(this.config, 'daemon', 'reply.missing', {
            event_id: event.id,
            reason: 'agent_cli_not_called',
          });
        await this.addReaction(event, COMPLETION_REACTION, 'completion');
      })
      .catch((error) =>
        logEvent(this.config, 'daemon', 'steer.completion.failed', {
          event_id: event.id,
          error: describeError(error),
        }),
      );
  }

  async handleEvent(event: InboundEvent): Promise<void> {
    if (!event.text?.trim() && !event.attachments?.length) return;
    const startedAt = Date.now();
    logEvent(this.config, 'daemon', 'event.received', {
      event_id: event.id,
      kind: event.kind,
      chat_id: event.chatId,
      text_chars: event.text.length,
    });
    this.channel.bindInbound(event);
    await this.addReaction(event, PROCESSING_REACTION, 'processing');
    writeCurrentContext(this.config, event);
    await this.refreshContextUsage(event.id);
    const message = this.messageFor(event);
    logEvent(this.config, 'daemon', 'prompt.start', { event_id: event.id });
    // Callbacks already recover through parent_notifications.
    const resumable = event.source !== 'session-callback';
    if (resumable) this.trackTurn(event, message);
    let finalText: string;
    try {
      finalText = await this.runner.promptAndWait(withContract(this.config, 'main', message));
    } finally {
      if (resumable) clearPendingTurn(this.config);
    }
    await this.refreshContextUsage(event.id);
    const context = readCurrentContext(this.config);
    const sends = context.sendCount || 0;
    const silent = isSilenceReply(finalText);
    logEvent(this.config, 'decision', 'turn.end', {
      event_id: event.id,
      kind: event.kind,
      source: event.source,
      sends,
      silent,
      ms: Date.now() - startedAt,
    });
    if (!sends)
      logEvent(this.config, 'daemon', silent ? 'reply.silent' : 'reply.missing', {
        event_id: event.id,
        reason: silent ? SILENCE_TOKEN : 'agent_cli_not_called',
      });
    await this.addReaction(event, COMPLETION_REACTION, 'completion');
  }

  /** Records the turn before it starts, keeping the recovery count of a resumed one. */
  private trackTurn(event: InboundEvent, message: string): void {
    const pending = readPendingTurn(this.config);
    const sameTurn = pending?.event.id === event.id;
    writePendingTurn(this.config, {
      event,
      message,
      startedAt: new Date().toISOString(),
      attempts: sameTurn ? pending.attempts : 0,
      steers: sameTurn ? pending.steers : [],
    });
  }

  /** A steer queued into the running turn has to replay with it, or the message is lost. */
  private recordSteer(message: string): void {
    const pending = readPendingTurn(this.config);
    if (!pending) return;
    writePendingTurn(this.config, { ...pending, steers: [...pending.steers, message] });
  }

  private async refreshContextUsage(eventId: string): Promise<void> {
    try {
      const usage = await this.runner.getContextUsage();
      recordContextUsage(this.config, usage, eventId);
      logEvent(this.config, 'daemon', 'context.usage', {
        event_id: eventId,
        value: usage.text,
        source: usage.source,
      });
    } catch (error) {
      logEvent(this.config, 'daemon', 'context.usage.failed', {
        event_id: eventId,
        error: describeError(error),
      });
    }
  }

  private async addReaction(event: InboundEvent, emojiType: string, phase: string): Promise<void> {
    if (!this.channel.sender.addReaction) return;
    const messageIds = reactionMessageIds(event);
    for (const messageId of messageIds) {
      try {
        await this.channel.sender.addReaction(messageId, emojiType);
        logEvent(this.config, 'daemon', 'reaction.added', {
          event_id: event.id,
          message_id: messageId,
          emoji: emojiType,
          phase,
        });
      } catch (error) {
        logEvent(this.config, 'daemon', 'reaction.failed', {
          event_id: event.id,
          message_id: messageId,
          emoji: emojiType,
          phase,
          error: describeError(error),
        });
      }
    }
  }

  private startCallbackPoller(): void {
    this.deliverCallbackNotifications();
    this.callbackPoller = setInterval(() => this.deliverCallbackNotifications(), 2000);
  }

  private deliverCallbackNotifications(): void {
    if (this.stopped || this.callbackDeliveryScheduled) return;
    if (!this.callbacksRecovered) {
      recoverParentNotifications(this.config);
      this.callbacksRecovered = true;
    }
    this.callbackDeliveryScheduled = true;
    const task = this.queue.then(async () => {
      while (!this.stopped) {
        // Claim only when main is ready, so a waiting backlog consumes no retry attempts.
        const [notice] = claimParentNotifications(this.config, 1);
        if (!notice) break;
        try {
          await this.handleEvent(noticeToInbound(notice));
          acknowledgeParentNotification(this.config, notice.id);
        } catch (error) {
          try {
            releaseParentNotification(this.config, notice.id);
          } catch (releaseError) {
            logEvent(this.config, 'session-callback', 'release.failed', {
              notice_id: notice.id,
              error: describeError(releaseError),
            });
          }
          logEvent(this.config, 'session-callback', 'delivery.failed', {
            notice_id: notice.id,
            error: describeError(error),
          });
        }
      }
    });
    this.queue = task
      .catch((error) =>
        logEvent(this.config, 'session-callback', 'poll.failed', { error: describeError(error) }),
      )
      .finally(() => {
        this.callbackDeliveryScheduled = false;
      });
  }

  private dedupeKey(event: InboundEvent): string | null {
    return this.channel.dedupeKey(event);
  }

  private isDuplicate(key: string): boolean {
    const now = Date.now();
    for (const [seenKey, seenAt] of this.seenInbound) {
      if (now - seenAt > DEDUPE_TTL_MS) this.seenInbound.delete(seenKey);
    }
    if (this.seenInbound.has(key)) return true;
    this.seenInbound.set(key, now);
    if (this.seenInbound.size > DEDUPE_MAX_KEYS) {
      const oldest = this.seenInbound.keys().next().value as string | undefined;
      if (oldest) this.seenInbound.delete(oldest);
    }
    return false;
  }

  async getState(): Promise<unknown> {
    return this.runner.getState();
  }

  async getMessages(): Promise<unknown> {
    return this.runner.getMessages();
  }

  stop(): void {
    this.stopped = true;
    this.runtimeCron.stop();
    if (this.callbackPoller) clearInterval(this.callbackPoller);
    this.channel.close();
    this.runner.close();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reactionMessageIds(event: InboundEvent): string[] {
  const rawEvents = Array.isArray(event.raw) ? event.raw.filter(isInboundEvent) : [event];
  return Array.from(
    new Set(rawEvents.map((item) => item.messageId).filter((id): id is string => !!id)),
  );
}

function isInboundEvent(value: unknown): value is InboundEvent {
  return typeof value === 'object' && value !== null && 'id' in value && 'text' in value;
}
