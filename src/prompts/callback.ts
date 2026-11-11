import type { ParentCompletionNotice, ParentReturnNotice } from '../core/sessions/callbacks.js';
import { joinBlocks, SILENCE_TOKEN } from './instructions.js';
import { localTimestamp } from './time.js';
import { element, inlineElement, promptBody } from './xml.js';

export function childCompletionPrompt(notice: ParentCompletionNotice): string {
  const { child } = notice;
  return joinBlocks([
    element(
      'child-session',
      {
        id: child.id,
        session: child.sessionId,
        status: child.status,
        cwd: child.cwd,
        dir: child.sessionDir,
        log: child.logPath,
        exit_code: child.exitCode ?? undefined,
        finished_at: localTimestamp(new Date(child.updatedAt)),
      },
      [
        child.error ? element('error', {}, promptBody(child.error)) : undefined,
        element('result', {}, promptBody(child.lastResult || '(no output)')),
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    actionBlock(child.id),
  ]);
}

export function childReturnPrompt(notice: ParentReturnNotice): string {
  const id = notice.child?.id ?? notice.child?.sessionId;
  return joinBlocks([
    element(
      'child-session',
      {
        id,
        session: notice.child?.sessionId,
        returned: 'true',
        reported_at: localTimestamp(new Date(notice.createdAt)),
      },
      element('text', {}, promptBody(notice.text)),
    ),
    actionBlock(id),
  ]);
}

function actionBlock(childId: string | undefined): string {
  const id = childId ?? '<id>';
  return element(
    'action',
    {},
    [
      `Review the result before deciding the task is done. If work remains, continue the child session or record a follow-up; otherwise send a truthful user-facing update. Reply ${SILENCE_TOKEN} when this result is already visible to the user.`,
      inlineElement('inspect-history', {}, `retriever sessions history ${id}`),
      inlineElement('continue-session', {}, `retriever sessions send ${id} --stdin`),
    ].join('\n'),
  );
}
