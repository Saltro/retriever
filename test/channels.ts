import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/extensions/index.js';
import { createMainAgentRunner } from '../src/core/agents/registry.js';
import {
  type ChannelAdapter,
  createChannelAdapter,
  registerChannelAdapter,
} from '../src/core/channels/registry.js';
import { unreadMessages } from '../src/core/channels/staleness.js';
import { PersonalDaemon } from '../src/core/daemon/daemon.js';
import { normalizeInbound } from '../src/core/events.js';
import {
  listParentNotifications,
  noticeToInbound,
  writeParentReturnNotification,
} from '../src/core/sessions/callbacks.js';
import { readVisibleBinding } from '../src/core/state/binding.js';
import { readCurrentContext, writeCurrentContext } from '../src/core/state/context.js';
import { getStateDb } from '../src/core/state/db.js';
import { attachFeishuResources } from '../src/extensions/feishu/attachments.js';
import type { FeishuApiResponse, FeishuTransport } from '../src/extensions/feishu/client.js';
import {
  forwardedTranscript,
  hasChat,
  MISSING_CHAT_ID,
  messageResources,
  messageText,
  normalizeFeishuInbound,
} from '../src/extensions/feishu/normalize.js';
import { FeishuSender, MockSender } from '../src/extensions/feishu/sender.js';
import { inboundMessagePrompt } from '../src/prompts/inbound.js';
import { isSilenceReply } from '../src/prompts/instructions.js';
import { runtimeContract } from '../src/prompts/system.js';
import type { AppConfig, InboundEvent, OutboundReply } from '../src/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-channels-'));
const config: AppConfig = {
  workspaceDir: tmp,
  agentProfiles: { default: { backend: 'mock' } },
  extensions: { pi: { bin: 'pi', extraArgs: [] }, feishu: { appId: '', appSecret: '' } },
  sender: { type: 'mock', mockOutbox: path.join(tmp, 'outbox') },
  stateDir: path.join(tmp, 'state'),
};
assert.throws(
  () => createChannelAdapter({ ...config, channel: { type: 'missing' } }),
  /Unknown channel/,
);
const received: string[] = [];
const replies: OutboundReply[] = [];
let closed = false;
registerChannelAdapter(
  'test-channel',
  (): ChannelAdapter => ({
    type: 'test-channel',
    label: 'test-channel',
    sender: {
      send: async (reply) => {
        replies.push(reply);
      },
    },
    start: async (onEvent) => {
      await onEvent(
        normalizeInbound(
          { type: 'message', id: 'channel-start', text: 'custom ingress' },
          'custom',
        ),
      );
    },
    close: () => {
      closed = true;
    },
    bindInbound: () => undefined,
    dedupeKey: (event) => `custom:${event.id}`,
  }),
);
assert.throws(
  () => registerChannelAdapter('test-channel', () => createChannelAdapter(config)),
  /already registered/,
);
const runner = createMainAgentRunner(config);
Object.assign(runner, {
  promptAndWait: async (prompt: string) => {
    received.push(prompt);
    return '';
  },
});
const daemon = new PersonalDaemon({ ...config, channel: { type: 'test-channel' } }, { runner });
daemon.start();
await daemon.enqueue(normalizeInbound({ type: 'wake', prompt: 'queue barrier' }, 'test'));
assert.ok(received.some((prompt) => prompt.includes('custom ingress')));
assert.ok(received.every((prompt) => !prompt.includes('Feishu')));
await daemon.enqueue(
  normalizeInbound({ type: 'message', id: 'channel-start', text: 'duplicate' }, 'custom'),
);
assert.equal(received.filter((prompt) => prompt.includes('duplicate')).length, 0);
await createChannelAdapter({ ...config, channel: { type: 'test-channel' } }).sender.send({
  chatId: 'fixed',
  inReplyTo: 'manual',
  text: 'custom egress',
});
assert.equal(replies[0].text, 'custom egress');
daemon.stop();
assert.equal(closed, true);
await assert.rejects(daemon.enqueue(normalizeInbound('after stop')), /stopped/);
const plainInbound = normalizeInbound('plain text');
assert.doesNotMatch(inboundMessagePrompt(plainInbound, 'terminal', true), /Feishu|Pi session/);
assert.doesNotMatch(inboundMessagePrompt(plainInbound, 'terminal', true), /retriever return/);
assert.match(inboundMessagePrompt(plainInbound, 'terminal', false), /retriever return --stdin/);
// The stable contract lives in the system prompt; per-message blocks carry only what varies.
const contractFor = (role: 'main' | 'child') => runtimeContract(role, '/tmp/AGENTS.md');
assert.match(contractFor('child'), /NO_REPLY/);
assert.match(contractFor('child'), /retriever send --stdin/);
assert.match(contractFor('main'), /NO_REPLY/);
assert.doesNotMatch(contractFor('main'), /retriever return --stdin/);
assert.match(contractFor('child'), /retriever return --stdin/);
assert.match(contractFor('main'), /A question is a complete run/);
assert.match(contractFor('child'), /Never `--wait`/);
assert.doesNotMatch(contractFor('main'), /unattended/);
assert.doesNotMatch(inboundMessagePrompt(plainInbound, 'terminal', true), /response-instructions/);
assert.equal(isSilenceReply(' NO_REPLY\n'), true);
assert.equal(isSilenceReply('NO_REPLY.'), false);
assert.equal(isSilenceReply('all done NO_REPLY'), false);

// Images and documents: a placeholder stands in for the payload, and the prompt
// carries the local path once the channel has downloaded the resource.
const imageMessage = {
  message_id: 'om_image',
  chat_id: 'oc-media',
  message_type: 'image',
  create_time: '1700000000000',
  content: JSON.stringify({ image_key: 'img_v2_key' }),
};
const imageEvent = normalizeFeishuInbound(
  { header: { event_id: 'evt-image' }, event: { message: imageMessage } },
  'feishu-ws',
);
assert.equal(imageEvent.text, '[image]');
assert.equal(imageEvent.attachments, undefined, 'normalizing never touches the network');
assert.deepEqual(messageResources(imageMessage), [
  { kind: 'image', key: 'img_v2_key', name: undefined },
]);
const fileMessage = {
  message_type: 'file',
  content: JSON.stringify({ file_key: 'file_v2_key', file_name: 'report.pdf' }),
};
assert.equal(messageText(fileMessage), '[file: report.pdf]');
assert.deepEqual(messageResources(fileMessage), [
  { kind: 'file', key: 'file_v2_key', name: 'report.pdf' },
]);
const postContent = {
  message_type: 'post',
  content: JSON.stringify({
    zh_cn: {
      title: 'chart',
      content: [
        [{ tag: 'text', text: 'look at this ' }],
        [{ tag: 'img', image_key: 'img_v2_inpost' }],
      ],
    },
  }),
};
assert.equal(messageText(postContent), 'chart\nlook at this\n[image]');
assert.deepEqual(messageResources(postContent), [
  { kind: 'image', key: 'img_v2_inpost', name: undefined },
]);
// A document attached to a rich-text message sits in a sibling `files` array.
const postFileContent = {
  message_type: 'post',
  content: JSON.stringify({
    title: '',
    content: [[{ tag: 'text', text: '发文件', style: [] }]],
    files: [{ file_key: 'file_v3_pdf', file_name: 'report.pdf', is_folder: false }],
  }),
};
assert.equal(messageText(postFileContent), '发文件\n[file: report.pdf]');
assert.deepEqual(messageResources(postFileContent), [
  { kind: 'file', key: 'file_v3_pdf', name: 'report.pdf' },
]);
// A forwarded topic or merged forward only carries a fixed placeholder; the
// transcript comes from the get-message API, one line per message.
assert.equal(
  messageText({ message_type: 'merge_forward', content: 'Merged and Forwarded Message' }),
  '[forwarded messages]',
);
assert.equal(
  forwardedTranscript([
    {
      message_id: 'om_child_1',
      msg_type: 'text',
      body: { content: JSON.stringify({ text: 'the cache is warm\nnow' }) },
      sender: { id: 'ou_speaker', sender_type: 'user' },
      upper_message_id: 'om_forward',
    },
    {
      message_id: 'om_child_2',
      msg_type: 'image',
      body: { content: JSON.stringify({ image_key: 'img_v2_child' }) },
      sender: { id: 'cli_app', sender_type: 'app' },
      upper_message_id: 'om_forward',
    },
  ]),
  '[forwarded 2 messages]\n1. ou_speaker: the cache is warm now\n2. bot: [image]',
);
const downloaded: InboundEvent = {
  ...imageEvent,
  text: '',
  attachments: [{ kind: 'image', path: path.join(tmp, 'attachments', '1-photo.png') }],
};
assert.match(
  inboundMessagePrompt(downloaded, 'Feishu', true),
  /<attachment kind="image" path="[^"]*1-photo\.png">/,
);
const attachmentPrompts: string[] = [];
const attachmentConfig: AppConfig = { ...config, stateDir: path.join(tmp, 'attachment-state') };
const attachmentRunner = createMainAgentRunner(attachmentConfig);
Object.assign(attachmentRunner, {
  promptAndWait: async (prompt: string) => {
    attachmentPrompts.push(prompt);
    return '';
  },
});
const attachmentDaemon = new PersonalDaemon(attachmentConfig, { runner: attachmentRunner });
await attachmentDaemon.enqueue(downloaded);
assert.ok(
  attachmentPrompts.some((prompt) => prompt.includes('1-photo.png')),
  'an image with no caption is still a task',
);
attachmentDaemon.stop();

// Topic messages: the thread id survives into the current context, so a reply is
// sent back into that thread instead of starting a new topic.
const topicEvent = normalizeFeishuInbound(
  {
    header: { event_id: 'evt-topic' },
    event: {
      message: {
        message_id: 'om_topic',
        chat_id: 'oc-topic',
        message_type: 'text',
        create_time: '1700000000000',
        thread_id: 'omt_d4be107c616',
        content: JSON.stringify({ text: 'in a topic' }),
      },
    },
  },
  'feishu-ws',
);
assert.equal(topicEvent.threadId, 'omt_d4be107c616');
assert.match(inboundMessagePrompt(topicEvent, 'Feishu', true), /thread="omt_d4be107c616"/);
assert.doesNotMatch(inboundMessagePrompt(plainInbound, 'Feishu', true), /thread=/);
const plainThreadless = normalizeFeishuInbound(
  {
    header: { event_id: 'evt-plain' },
    event: {
      message: {
        message_id: 'om_plain',
        chat_id: 'oc-topic',
        message_type: 'text',
        create_time: '1700000000000',
        content: JSON.stringify({ text: 'quote reply, no topic' }),
      },
    },
  },
  'feishu-ws',
);
assert.equal(plainThreadless.threadId, undefined, 'root_id alone is not a topic');
// An event without a chat id cannot be bound or answered, so it is dropped before
// delivery instead of inventing a chat named after a sentinel.
const orphanChat = normalizeFeishuInbound(
  {
    header: { event_id: 'evt-orphan' },
    event: {
      message: {
        message_id: 'om_orphan',
        message_type: 'text',
        create_time: '1700000000000',
        content: JSON.stringify({ text: 'no chat' }),
      },
    },
  },
  'feishu-ws',
);
assert.equal(orphanChat.chatId, MISSING_CHAT_ID);
assert.equal(hasChat(orphanChat), false);
assert.equal(hasChat(topicEvent), true);
assert.equal(hasChat(normalizeInbound({ type: 'wake', prompt: 'tick' }, 'test')), true);
const topicConfig: AppConfig = { ...config, stateDir: path.join(tmp, 'topic-state') };
writeCurrentContext(topicConfig, topicEvent);
assert.equal(readCurrentContext(topicConfig).threadId, 'omt_d4be107c616');
writeCurrentContext(topicConfig, plainThreadless);
assert.equal(readCurrentContext(topicConfig).threadId, undefined, 'a plain message clears it');

// Inbound enrichment and outbound uploads are request shaping, so they are tested
// against a fake transport that records the path and body of every call.
interface Call {
  kind: 'request' | 'upload' | 'download';
  path: string;
  body?: unknown;
  form?: FormData;
}

function fakeTransport(options: {
  items?: unknown[];
  download?: (path: string) => Buffer;
  calls: Call[];
}): FeishuTransport {
  return {
    request: async <T = FeishuApiResponse>(
      path: string,
      requestOptions: { json?: unknown } = {},
    ): Promise<T> => {
      options.calls.push({ kind: 'request', path, body: requestOptions.json });
      if (path.includes('/messages/om_forward')) return { data: { items: options.items } } as T;
      return {} as T;
    },
    upload: async (path: string, form: FormData) => {
      options.calls.push({ kind: 'upload', path, form });
      return {
        data: path.includes('/images')
          ? { image_key: 'img_uploaded' }
          : { file_key: 'file_uploaded' },
      };
    },
    download: async (path: string) => {
      options.calls.push({ kind: 'download', path });
      if (options.download) return options.download(path);
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    },
  };
}

const resourceCalls: Call[] = [];
const resourceConfig: AppConfig = { ...config, stateDir: path.join(tmp, 'resource-state') };
const imagePost = {
  title: '',
  content: [[{ tag: 'img', image_key: 'img_v3_key' }], [{ tag: 'text', text: 'chart' }]],
};
const directEvent: InboundEvent = {
  id: 'evt-direct',
  source: 'feishu-ws',
  kind: 'message',
  chatId: 'oc_direct',
  text: '[image]chart',
  raw: {
    event: {
      message: {
        message_id: 'om_direct',
        message_type: 'post',
        content: JSON.stringify(imagePost),
      },
    },
  },
};
const directEnriched = await attachFeishuResources(
  resourceConfig,
  directEvent,
  fakeTransport({ calls: resourceCalls }),
);
assert.equal(directEnriched.attachments?.length, 1);
assert.match(directEnriched.attachments![0].path, /attachments\/om_direct\/1-image-1\.png$/);
assert.equal(
  resourceCalls.find((call) => call.kind === 'download')?.path,
  '/open-apis/im/v1/messages/om_direct/resources/img_v3_key?type=image',
);

// A forwarded topic: children are ordered by create time, and their resources are
// fetched through the container message id, which is the id the API accepts.
const forwardCalls: Call[] = [];
const forwardEvent: InboundEvent = {
  id: 'evt-forward',
  source: 'feishu-ws',
  kind: 'message',
  chatId: 'oc_direct',
  text: '[forwarded messages]',
  raw: {
    message: {
      message_id: 'om_forward',
      message_type: 'merge_forward',
      content: 'Merged and Forwarded Message',
    },
  },
};
const forwardEnriched = await attachFeishuResources(
  resourceConfig,
  forwardEvent,
  fakeTransport({
    calls: forwardCalls,
    items: [
      { message_id: 'om_forward', msg_type: 'merge_forward' },
      {
        message_id: 'om_second',
        msg_type: 'post',
        create_time: '2000',
        upper_message_id: 'om_forward',
        sender: { id: 'ou_b', sender_type: 'user' },
        body: { content: JSON.stringify(imagePost) },
      },
      {
        message_id: 'om_first',
        msg_type: 'text',
        create_time: '1000',
        upper_message_id: 'om_forward',
        sender: { id: 'ou_a', sender_type: 'user' },
        body: { content: JSON.stringify({ text: 'first note' }) },
      },
    ],
  }),
);
assert.equal(
  forwardEnriched.text,
  '[forwarded 2 messages]\n1. ou_a: first note\n2. ou_b: [image] chart',
  'children keep platform order',
);
assert.match(
  forwardCalls.find((call) => call.kind === 'download')?.path ?? '',
  /\/messages\/om_forward\/resources\/img_v3_key/,
  'child resources go through the container id',
);
assert.equal(forwardEnriched.attachments?.length, 1);

// A failed download leaves a readable note and still delivers the message.
const failedEnriched = await attachFeishuResources(
  resourceConfig,
  directEvent,
  fakeTransport({
    calls: [],
    download: () => {
      throw new Error('Feishu download failed http=403 no permission');
    },
  }),
);
assert.equal(failedEnriched.attachments?.length, 0);
assert.match(failedEnriched.text, /\[image unavailable\]/);

// Audio and video stay placeholders: nothing downloads them.
assert.deepEqual(messageResources({ message_type: 'media', content: '{"file_key":"file_v"}' }), []);
assert.equal(messageText({ message_type: 'media', content: '{"file_key":"file_v"}' }), '[video]');

// Outbound: one resource per message, uploaded first and then sent by key.
const uploadCalls: Call[] = [];
const feishuSender = new FeishuSender(
  { appId: 'cli_test', appSecret: 'secret' },
  fakeTransport({ calls: uploadCalls }),
);
const imagePath = path.join(tmp, 'chart.png');
fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
await feishuSender.sendAttachment('oc_direct', { kind: 'image', path: imagePath });
assert.deepEqual(
  uploadCalls.map((call) => [call.kind, call.path]),
  [
    ['upload', '/open-apis/im/v1/images'],
    ['request', '/open-apis/im/v1/messages?receive_id_type=chat_id'],
  ],
);
assert.deepEqual(uploadCalls[1].body, {
  receive_id: 'oc_direct',
  msg_type: 'image',
  content: JSON.stringify({ image_key: 'img_uploaded' }),
});
// A topic attachment replies inside the thread instead of starting a new topic.
uploadCalls.length = 0;
await feishuSender.sendAttachment(
  'oc_direct',
  { kind: 'image', path: imagePath },
  { thread: { id: 'omt_test', anchorMessageId: 'om_direct' } },
);
assert.deepEqual(uploadCalls[1], {
  kind: 'request',
  path: '/open-apis/im/v1/messages/om_direct/reply',
  body: {
    msg_type: 'image',
    content: JSON.stringify({ image_key: 'img_uploaded' }),
    reply_in_thread: true,
  },
});
// A file needs an extension, and Feishu's size cap is checked before uploading.
await assert.rejects(
  feishuSender.sendAttachment('oc_direct', {
    kind: 'file',
    path: (() => {
      const file = path.join(tmp, 'no-extension');
      fs.writeFileSync(file, 'x');
      return file;
    })(),
  }),
  /no file extension/,
);
const oversized = path.join(tmp, 'oversized.png');
fs.writeFileSync(oversized, Buffer.alloc(10 * 1024 * 1024 + 1));
await assert.rejects(
  feishuSender.sendAttachment('oc_direct', { kind: 'image', path: oversized }),
  /at most 10485760/,
);
assert.ok(new MockSender({ type: 'mock', mockOutbox: path.join(tmp, 'unused') }));

// A resource call answers HTTP 200 with a JSON envelope when the app lacks the
// permission; that body must fail instead of becoming the attachment file.
const realFetch = globalThis.fetch;
const fetchCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  fetchCalls.push(url);
  if (url.includes('tenant_access_token')) {
    return new Response(
      JSON.stringify({ code: 0, tenant_access_token: 'stub-token', expire: 7200 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(JSON.stringify({ code: 99991672, msg: 'no resource permission' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
try {
  const { FeishuClient } = await import('../src/extensions/feishu/client.js');
  const stubbed = new FeishuClient({ appId: 'cli_test', appSecret: 'secret' });
  await assert.rejects(
    stubbed.download('/open-apis/im/v1/messages/om_x/resources/img_key?type=image'),
    /code=99991672/,
  );
  assert.equal(fetchCalls.filter((url) => url.includes('/resources/')).length, 1);
} finally {
  globalThis.fetch = realFetch;
}

const stdinConfig: AppConfig = {
  ...config,
  channel: { type: 'stdin' },
  stateDir: path.join(tmp, 'stdin-state'),
};
const stdinDaemon = new PersonalDaemon(stdinConfig);
await stdinDaemon.enqueue(
  normalizeInbound(
    { type: 'message', chatId: 'terminal-destination', text: 'stdin ingress' },
    'stdin',
  ),
);
assert.equal(readVisibleBinding(stdinConfig)?.chatId, 'terminal-destination');
assert.equal(readCurrentContext(stdinConfig).textChars, 'stdin ingress'.length);
stdinDaemon.stop();
const file = path.join(tmp, 'config.json');
fs.writeFileSync(file, JSON.stringify(stdinConfig));
const send = spawnSync(
  process.execPath,
  [path.resolve(import.meta.dirname, '../dist/index.js'), 'send', 'stdin egress'],
  {
    cwd: tmp,
    env: { ...process.env, RETRIEVER_CONFIG: file },
    encoding: 'utf8',
    timeout: 5000,
  },
);
assert.equal(send.status, 0, send.stderr);
assert.equal(send.stdout, 'stdin egress\n');
assert.equal(readCurrentContext(stdinConfig).sendCount, 1);

const queuedConfig = { ...config, stateDir: path.join(tmp, 'queued-state') };
const queuedPrompts: string[] = [];
let active = false;
let releaseFirst!: () => void;
let startedFirst!: () => void;
let startedSecond!: () => void;
const firstStarted = new Promise<void>((resolve) => {
  startedFirst = resolve;
});
const secondStarted = new Promise<void>((resolve) => {
  startedSecond = resolve;
});
const firstReleased = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});
const queuedRunner = createMainAgentRunner(queuedConfig);
Object.assign(queuedRunner, {
  capabilities: { prompt: true, steer: false, history: false, contextUsage: false },
  isRunning: () => active,
  steer: async () => {
    assert.fail('unsupported steer must not be called');
  },
  promptAndWait: async (prompt: string) => {
    assert.equal(active, false, 'non-steer backend prompts must not overlap');
    active = true;
    queuedPrompts.push(prompt);
    if (queuedPrompts.length === 1) {
      startedFirst();
      await firstReleased;
    } else startedSecond();
    active = false;
    return '';
  },
});
const queuedDaemon = new PersonalDaemon(queuedConfig, { runner: queuedRunner });
void queuedDaemon.enqueue(
  normalizeInbound({ type: 'message', id: 'queued-first', text: 'first queued prompt' }, 'feishu'),
);
await firstStarted;
void queuedDaemon.enqueue(
  normalizeInbound(
    { type: 'message', id: 'queued-second', text: 'second queued prompt' },
    'feishu',
  ),
);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(queuedPrompts.length, 1);
releaseFirst();
await secondStarted;
await queuedDaemon.enqueue(normalizeInbound({ type: 'wake', prompt: 'queued barrier' }, 'test'));
assert.match(queuedPrompts[0], /first queued prompt/);
assert.match(queuedPrompts[1], /second queued prompt/);
queuedDaemon.stop();

const callbackConfig = { ...config, stateDir: path.join(tmp, 'callback-state') };
writeParentReturnNotification(
  callbackConfig,
  { sessionId: 'parent', cwd: tmp, queuePath: '', createdAt: new Date().toISOString() },
  'retry callback',
);
const callback = listParentNotifications(callbackConfig)[0];
assert.doesNotMatch(noticeToInbound(callback).prompt ?? '', /Feishu|Child Pi session/);
const completion = noticeToInbound({
  type: 'session.completed',
  id: 'completion-neutral',
  createdAt: new Date().toISOString(),
  parent: callback.parent,
  child: {
    id: 'process-child',
    sessionId: 'process-child',
    cwd: tmp,
    status: 'completed',
    logPath: '',
    updatedAt: new Date().toISOString(),
  },
});
assert.doesNotMatch(completion.prompt ?? '', /Feishu|Child Pi session/);
const failingRunner = createMainAgentRunner(callbackConfig);
Object.assign(failingRunner, {
  promptAndWait: async () => {
    throw new Error('fake agent failure');
  },
});
const failingDaemon = new PersonalDaemon(callbackConfig, { runner: failingRunner });
await assert.rejects(
  failingDaemon.enqueue(normalizeInbound({ type: 'wake', prompt: 'trigger drain' }, 'test')),
  /fake agent failure/,
);
assert.equal(listParentNotifications(callbackConfig).length, 1);
failingDaemon.stop();

const backlogConfig = { ...config, stateDir: path.join(tmp, 'backlog-state') };
const parent = { sessionId: 'main', cwd: tmp, queuePath: '', createdAt: new Date().toISOString() };
const backlogIds = [
  writeParentReturnNotification(backlogConfig, parent, 'slow callback'),
  writeParentReturnNotification(backlogConfig, parent, 'waiting callback'),
];
let releaseCallback!: () => void;
let callbackStarted!: () => void;
let activeCallback: string | undefined;
const callbackStartedTask = new Promise<void>((resolve) => {
  callbackStarted = resolve;
});
const callbackReleased = new Promise<void>((resolve) => {
  releaseCallback = resolve;
});
const backlogRunner = createMainAgentRunner(backlogConfig);
Object.assign(backlogRunner, {
  promptAndWait: async () => {
    activeCallback = readCurrentContext(backlogConfig).eventId;
    assert.ok(activeCallback);
    callbackStarted();
    await callbackReleased;
    return '';
  },
});
const backlogDaemon = new PersonalDaemon(backlogConfig, { runner: backlogRunner });
const stoppedDelivery = backlogDaemon.enqueue(
  normalizeInbound({ type: 'wake', prompt: 'after callbacks' }, 'test'),
);
const rejectedAfterStop = assert.rejects(stoppedDelivery, /stopped/i);
await callbackStartedTask;
const waitingCallback = backlogIds.find((id) => id !== activeCallback)!;
const waitingRow = () =>
  getStateDb(backlogConfig)
    .prepare('SELECT status, attempts FROM parent_notifications WHERE id=?')
    .get(waitingCallback)!;
assert.equal(waitingRow().status, 'pending');
assert.equal(waitingRow().attempts, 0);
backlogDaemon.stop();
releaseCallback();
await rejectedAfterStop;
assert.equal(waitingRow().status, 'pending');
assert.equal(waitingRow().attempts, 0);
const resumedRunner = createMainAgentRunner(backlogConfig);
const resumedPrompts: string[] = [];
Object.assign(resumedRunner, {
  promptAndWait: async (prompt: string) => {
    resumedPrompts.push(prompt);
    return '';
  },
});
const resumedDaemon = new PersonalDaemon(backlogConfig, { runner: resumedRunner });
await resumedDaemon.enqueue(normalizeInbound({ type: 'wake', prompt: 'resumed barrier' }, 'test'));
const waitingText = waitingCallback === backlogIds[0] ? 'slow callback' : 'waiting callback';
assert.ok(resumedPrompts.some((prompt) => prompt.includes(waitingText)));
assert.equal(listParentNotifications(backlogConfig).length, 0);
resumedDaemon.stop();
// Staleness: the anchor is the message current context was written for.
const anchor = { messageId: 'om_2', messageCreateTime: 2000 };
const recent = [
  { messageId: 'om_3', createTime: 3000, text: 'newest' },
  { messageId: 'om_2', createTime: 2000, text: 'anchor' },
  { messageId: 'om_1', createTime: 1000, text: 'older' },
  { messageId: 'om_bot', createTime: 4000, text: 'own reply', fromSelf: true },
];
assert.deepEqual(
  unreadMessages(anchor, recent).map((message) => message.messageId),
  ['om_3'],
  'only messages newer than the anchor count',
);
assert.deepEqual(unreadMessages(anchor, recent.slice(1)), []);
assert.deepEqual(
  unreadMessages({ messageId: 'om_1', messageCreateTime: 2000 }, recent).map((m) => m.messageId),
  ['om_3', 'om_2'],
  'an equal timestamp from a different message counts as unread',
);
assert.deepEqual(
  unreadMessages({ messageId: 'om_2' }, recent),
  [],
  'an unknown platform time disables the check instead of blocking every send',
);
assert.deepEqual(unreadMessages(anchor, []), []);

console.log('channels ok');
