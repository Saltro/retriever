import { joinBlocks, responseInstructions } from './instructions.js';
import { localTimestamp } from './time.js';
import { element, promptBody } from './xml.js';

export interface DelegatedTaskOptions {
  isMainSession?: boolean;
  /** Mirrors the child record: a run that returns automatically needs no manual report. */
  autoReturn?: boolean;
  assignedAt?: Date;
}

/** A task handed to a child session by the main session, not a scheduled or incoming event. */
export function delegatedTaskPrompt(
  task: string,
  { isMainSession = false, autoReturn = false, assignedAt = new Date() }: DelegatedTaskOptions = {},
): string {
  const completion = isMainSession
    ? undefined
    : autoReturn
      ? 'Your final message is returned to the parent session automatically.'
      : 'Your final message stays in this session; nothing is delivered to the parent automatically.';
  return joinBlocks([
    element(
      'delegated-task',
      { assigned_at: localTimestamp(assignedAt) },
      [promptBody(task), completion ? element('completion', {}, completion) : undefined]
        .filter(Boolean)
        .join('\n'),
    ),
    responseInstructions({ isMainSession, autoReturn }),
  ]);
}
