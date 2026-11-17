import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/extensions/index.js';
import type { AgentRunner } from '../src/core/agents/types.js';
import type { ChannelAdapter } from '../src/core/channels/registry.js';
import { PersonalDaemon } from '../src/core/daemon/daemon.js';
import { normalizeInbound } from '../src/core/events.js';
import { getStateDb } from '../src/core/state/db.js';
import { clearPendingTurn, readPendingTurn, writePendingTurn } from '../src/core/state/turn.js';
import type { AppConfig, InboundEvent } from '../src/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retriever-turn-recovery-'));
const config: AppConfig = {
  workspaceDir: tmp,
  agentProfiles: { default: { backend: 'mock' } },
  extensions: { pi: { bin: 'pi', extraArgs: [] }, feishu: { appId: '', appSecret: '' } },
  channel: { type: 'stdin' },
  sender: { type: 'mock', mockOutbox: path.join(tmp, 'outbox') },
  stateDir: path.join(tmp, 'state'),
};

function fakeChannel(): ChannelAdapter {
  return {
    type: 'fake',
    label: 'fake',
    sender: { send: async () => ({}), addReaction: async () => ({}) },
    start: async () => {},
    close: () => {},
    bindInbound: (_event: InboundEvent) => {},
    dedupeKey: () => null,
  };
}

interface RecordingRunner extends AgentRunner {
  prompts: string[];
  pendingAtPrompt: Array<ReturnType<typeof readPendingTurn>>;
}

function recordingRunner(settle = true): RecordingRunner {
  const prompts: string[] = [];
  const pendingAtPrompt: Array<ReturnType<typeof readPendingTurn>> = [];
  const runner = {
    capabilities: { prompt: true, steer: false, history: false, contextUsage: false },
    prompts,
    pendingAtPrompt,
    start: () => {},
    isRunning: () => false,
    waitForSettled: async () => {},
    steer: async () => ({ disposition: 'handled' as const }),
    getState: async () => ({ backend: 'fake' }),
    getMessages: async () => ({}),
    getContextUsage: async () => ({ text: 'Context usage unavailable', source: 'fake' }),
    close: () => {},
    promptAndWait: (message: string) => {
      prompts.push(message);
      pendingAtPrompt.push(readPendingTurn(config));
      // A turn that never settles stands in for the process dying mid-turn.
      return settle ? Promise.resolve('NO_REPLY') : new Promise<string>(() => {});
    },
  };
  return runner as RecordingRunner;
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const event = normalizeInbound(
  { type: 'message', id: 'evt-stage', chatId: 'chat-1', text: 'ship the release notes' },
  'test',
);

clearPendingTurn(config);
assert.equal(readPendingTurn(config), undefined, 'no record means no turn to recover');

// The interrupted daemon: the turn starts, its record is written, then the process dies.
const interrupted = recordingRunner(false);
void new PersonalDaemon(config, { runner: interrupted, channel: fakeChannel() }).handleEvent(event);
await until(() => interrupted.prompts.length === 1, 'the interrupted turn to start');
const recorded = readPendingTurn(config);
assert.equal(recorded?.event.id, 'evt-stage');
assert.equal(recorded?.attempts, 0);
assert.match(recorded?.message ?? '', /ship the release notes/);
assert.doesNotMatch(recorded?.message ?? '', /Retriever runtime/, 'the contract is not stored');

// The next daemon re-delivers the request instead of waiting for a new message.
const resumed = recordingRunner();
const daemon = new PersonalDaemon(config, { runner: resumed, channel: fakeChannel() });
daemon.start();
await until(() => resumed.prompts.length === 1, 'the recovered turn');
const recovered = resumed.prompts[0];
assert.match(recovered, /<resumed-turn/);
assert.match(recovered, /reason="retriever terminated while this turn was still running/);
assert.match(recovered, /attempt_started_at="[^"]+"/);
assert.match(recovered, /resumed_at="[^"]+"/);
assert.match(recovered, /channel="fake"/);
assert.match(recovered, /This attempt ended mid-turn with no reply confirmed for the user/);
assert.match(recovered, /ship the release notes/);
assert.match(recovered, /Retriever runtime/, 'the contract wraps the recovered prompt once');
assert.equal(resumed.pendingAtPrompt[0]?.attempts, 1);
assert.equal(readPendingTurn(config), undefined, 'a finished turn is not recovered again');
daemon.stop();

// A turn that fails still clears its record: only a lost process leaves work behind.
const failing = recordingRunner();
failing.promptAndWait = () => Promise.reject(new Error('model unavailable'));
await assert.rejects(
  new PersonalDaemon(config, { runner: failing, channel: fakeChannel() }).handleEvent(event),
  /model unavailable/,
);
assert.equal(readPendingTurn(config), undefined);

// Recovery is bounded, so a turn that keeps killing the daemon cannot loop forever.
writePendingTurn(config, {
  event,
  message: 'ship the release notes',
  startedAt: '2026-01-01T00:00:00.000Z',
  attempts: 2,
});
const capped = recordingRunner();
const cappedDaemon = new PersonalDaemon(config, { runner: capped, channel: fakeChannel() });
cappedDaemon.start();
cappedDaemon.stop();
assert.equal(capped.prompts.length, 0, 'a turn that died twice is dropped');
assert.equal(readPendingTurn(config), undefined);

// A malformed record is dropped instead of blocking startup.
const db = getStateDb(config);
db.prepare("UPDATE state_meta SET value = 'not json' WHERE key = 'pending-turn'").run();
assert.equal(readPendingTurn(config), undefined);
assert.equal(
  db.prepare("SELECT value FROM state_meta WHERE key = 'pending-turn'").get(),
  undefined,
  'the broken record is removed',
);

console.log('turn recovery tests passed');
