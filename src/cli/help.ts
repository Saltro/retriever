import { CHAT_REPLY_LIMIT } from './send.js';

export interface CommandHelp {
  name: string;
  summary: string;
  usage: string[];
  notes?: string[];
  output?: string;
}

/**
 * The tool surface as the agent sees it. This is the authoritative description of
 * every command, kept in one place so help text and prompts cannot drift.
 */
export const COMMANDS: CommandHelp[] = [
  {
    name: 'send',
    summary: 'Deliver a chat message to the person on the current channel.',
    usage: [
      'retriever send [--long] [--rebase|--force] <text...>',
      'retriever send [--long] [--rebase|--force] --stdin',
    ],
    notes: [
      'Bound to the current event; no chat id is needed.',
      'This is the only way a person sees your output.',
      `Default limit is ${CHAT_REPLY_LIMIT} characters: split longer answers into a few sends, which reads more like a conversation.`,
      'A normal reply is a chat message rendered from markdown, with the context estimate as an italic last line.',
      '--long lifts the limit and switches to a card, for code, tables or anything that must arrive as one message.',
      'If newer messages arrived while you were composing, the send is refused with their text: --rebase when the reply already accounts for them, --force when they do not affect it.',
    ],
    output:
      'Nothing on success. Exit code 2 when the text is over the limit, 3 when the reply is behind the conversation.',
  },
  {
    name: 'return',
    summary: 'Deliver a result to the parent session that delegated this work.',
    usage: ['retriever return <text...>', 'retriever return --stdin'],
    notes: [
      'Fails in the main session: it has no parent.',
      'Interim findings belong here; use it freely while work is still running.',
    ],
    output: 'Nothing on success; the parent is woken by the daemon.',
  },
  {
    name: 'sessions create',
    summary: 'Start a child session and optionally send it a first task.',
    usage: [
      'retriever sessions create [--id <id>] [--name <name>] [--agent <profile>]',
      '    [--cwd <dir>] [--return|--no-return] [--prompt <text>|--stdin] [--wait]',
    ],
    notes: [
      '--return makes the runtime send the parent a completion notice; without it the child must run `retriever return` itself.',
      '--wait blocks until the child finishes; omit it to run in the background.',
    ],
    output: 'The new session record as JSON.',
  },
  {
    name: 'sessions send',
    summary: 'Send a message to an existing session, continuing its conversation.',
    usage: [
      'retriever sessions send <id> [--message <text>|--stdin] [--wait] [--return|--no-return]',
    ],
    notes: ['A session that is already running rejects a new prompt.'],
    output: 'The updated session record as JSON.',
  },
  {
    name: 'sessions list',
    summary: 'List sessions with status, return flag and last update time.',
    usage: ['retriever sessions list'],
    output: 'An aligned table.',
  },
  {
    name: 'sessions status',
    summary: 'Show one session in detail.',
    usage: ['retriever sessions status <id>'],
    output: 'A readable summary; --json prints the raw record.',
  },
  {
    name: 'sessions history',
    summary: 'Print the tail of a session log, including every prompt it received.',
    usage: ['retriever sessions history <id> [--lines <n>]'],
    notes: ['The fastest way to see what a child session actually did.'],
    output: 'Raw log lines, default 40.',
  },
  {
    name: 'main-session',
    summary: 'Show or change which session is the main session.',
    usage: ['retriever main-session [status]', 'retriever main-session use <session-id>'],
    notes: ['Restart the daemon after changing it: the main runner is bound at startup.'],
    output: 'The selected session record as JSON.',
  },
  {
    name: 'cron',
    summary: 'Manage scheduled runs.',
    usage: [
      'retriever cron create --id <id> --prompt <text>|--stdin (--cron <expr>|--at <time>)',
      '    [--target main|new|session:<id>] [--target-session <id>] [--enabled|--disabled]',
      'retriever cron update <id> [...]',
      'retriever cron list | status <id> | disable <id> | delete <id>',
    ],
    notes: [
      'A scheduled run tells the agent its cron id, schedule and fire time, and that it is not a user message.',
      'target=main wakes the main session; target=new starts a child session; target=session:<id> reuses one.',
    ],
    output: 'The cron record as JSON for mutations; a table for `list`.',
  },
  {
    name: 'bind',
    summary: 'Inspect or set where `send` delivers.',
    usage: ['retriever bind status', 'retriever bind destination --chat-id <id>'],
    output: 'The current binding as JSON.',
  },
  {
    name: 'daemon',
    summary: 'Control the background daemon.',
    usage: ['retriever daemon <start|stop|restart|status>'],
    output: 'Status as JSON; start/stop/restart print nothing on success.',
  },
  {
    name: 'update',
    summary: 'Upgrade the installed retriever package.',
    usage: ['retriever update [--latest]'],
  },
  {
    name: 'version',
    summary: 'Print the installed version.',
    usage: ['retriever version', 'retriever -v', 'retriever --version'],
  },
];

/** `sessions` resolves to the whole group; `sessions create` resolves to one command. */
export function findCommands(name: string): CommandHelp[] {
  const key = name.trim();
  const exact = COMMANDS.filter((command) => command.name === key);
  if (exact.length) return exact;
  return COMMANDS.filter((command) => command.name.split(' ')[0] === key);
}

export function renderCommandHelp(command: CommandHelp): string {
  const lines = [command.summary, '', 'Usage:', ...command.usage.map((line) => `  ${line}`)];
  if (command.notes?.length)
    lines.push('', 'Notes:', ...command.notes.map((note) => `  - ${note}`));
  if (command.output) lines.push('', `Output: ${command.output}`);
  return lines.join('\n');
}

export function renderHelp(name?: string): string {
  if (name) {
    const commands = findCommands(name);
    if (!commands.length) return `Unknown command: ${name}\n\n${renderHelp()}`;
    return commands.map(renderCommandHelp).join('\n\n');
  }
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  return [
    'Personal agent daemon: one chat surface, child sessions that report back, and',
    'scheduled wakeups.',
    '',
    'Commands:',
    ...COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    '',
    'Run `retriever help <command>` for arguments, notes and output shape.',
  ].join('\n');
}
