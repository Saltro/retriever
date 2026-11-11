import { element, inlineElement } from './xml.js';

export const SILENCE_TOKEN = 'NO_REPLY';

/** A run that ends silently is a deliberate outcome, distinguishable from a forgotten reply. */
export function isSilenceReply(text: string): boolean {
  return text.trim() === SILENCE_TOKEN;
}

export interface ResponseOptions {
  isMainSession: boolean;
  /** A child whose run returns automatically has nothing to report back manually. */
  autoReturn?: boolean;
}

/**
 * Only the parts that vary per run. The stable contract — send, NO_REPLY, honesty
 * rules — arrives once through the system prompt, so repeating it here would let
 * the two copies drift.
 */
export function responseInstructions({
  isMainSession,
  autoReturn = false,
}: ResponseOptions): string {
  if (isMainSession || autoReturn) return '';
  return element(
    'response-instructions',
    {},
    inlineElement(
      'return',
      {},
      'retriever return --stdin — deliver a result to the parent session; your final message stays here',
    ),
  );
}

export function joinBlocks(blocks: Array<string | undefined>): string {
  return blocks.filter((block): block is string => !!block && !!block.trim()).join('\n\n');
}
