import { joinBlocks, responseInstructions } from './instructions.js';
import { localTimestamp, utcTimestamp } from './time.js';
import { element, promptBody } from './xml.js';

export interface ScheduledWakeup {
  cronId: string;
  schedule: { type: 'cron'; expression: string } | { type: 'at'; at: string };
  firedAt: Date;
  prompt: string;
  isMainSession: boolean;
}

export function scheduledWakeupPrompt(wakeup: ScheduledWakeup): string {
  const { schedule } = wakeup;
  return joinBlocks([
    element(
      'scheduled-wakeup',
      {
        cron_id: wakeup.cronId,
        schedule:
          schedule.type === 'cron'
            ? schedule.expression
            : `once at ${localTimestamp(new Date(schedule.at))}`,
        fired_at: localTimestamp(wakeup.firedAt),
        utc: utcTimestamp(wakeup.firedAt),
      },
      [
        'This is a scheduled run, not a message from the user.',
        element('task', {}, promptBody(wakeup.prompt)),
      ].join('\n'),
    ),
    responseInstructions({ isMainSession: wakeup.isMainSession }),
  ]);
}
