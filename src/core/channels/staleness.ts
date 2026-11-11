import type { RecentMessage, RuntimeContext } from '../../types.js';

export const RECENT_MESSAGE_WINDOW = 20;

/**
 * Messages the agent has not accounted for. The anchor is the message current
 * context was written for, so ordering comes from the platform's create time and
 * survives log trimming, restarts and clock skew.
 *
 * A tie on create time counts as behind: a false rejection is recoverable with
 * --force, a missed interruption is not.
 */
export function unreadMessages(
  context: Pick<RuntimeContext, 'messageId' | 'messageCreateTime'>,
  recent: RecentMessage[],
): RecentMessage[] {
  if (context.messageCreateTime === undefined) return [];
  const anchorTime = context.messageCreateTime;
  const anchorId = context.messageId;
  return recent.filter((message) => {
    if (message.fromSelf) return false;
    if (message.createTime > anchorTime) return true;
    return message.createTime === anchorTime && message.messageId !== anchorId;
  });
}
