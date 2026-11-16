import type { AgentAdapter } from '../../core/agents/types.js';
import { agentProcessEnv } from '../../core/runtime/process-paths.js';
import { PiRpcRunner } from './runner.js';

export const piAdapter: AgentAdapter = {
  sessionCapabilities: { prompt: true, steer: true, history: true, contextUsage: true },
  createMainRunner(config, profile, record) {
    if (profile.backend !== 'pi') throw new Error('invalid Pi agent profile');
    const runner = new PiRpcRunner(config, {
      cwd: record?.cwd ?? profile.cwd,
      sessionDir: record?.sessionDir ?? profile.sessionDir,
      sessionId: record?.sessionId,
      record,
      bin: profile.bin || config.extensions.pi.bin,
      extraArgs: profile.extraArgs || [],
      commandTimeoutMs: profile.timeoutMs,
    });
    return Object.assign(runner, {
      capabilities: { prompt: true, steer: true, history: true, contextUsage: true },
    });
  },
  /** A child keeps an RPC process for the length of its run, so it can be steered. */
  createSessionRunner(config, profile, record) {
    if (profile.backend !== 'pi') throw new Error('invalid Pi agent profile');
    const runner = new PiRpcRunner(config, {
      cwd: record.cwd,
      sessionDir: record.sessionDir,
      sessionId: record.sessionId,
      record,
      bin: profile.bin || config.extensions.pi.bin,
      extraArgs: profile.extraArgs || [],
      settledTimeoutMs: profile.timeoutMs,
    });
    return Object.assign(runner, {
      capabilities: { prompt: true, steer: true, history: true, contextUsage: true },
    });
  },
  sessionProcess(config, profile, record, prompt) {
    if (profile.backend !== 'pi') throw new Error('invalid Pi agent profile');
    return {
      command: profile.bin || config.extensions.pi.bin,
      args: [
        '--print',
        '--session-id',
        record.sessionId,
        ...(record.sessionDir ? ['--session-dir', record.sessionDir] : []),
        '--approve',
        prompt,
        ...(profile.extraArgs || []),
      ],
      env: agentProcessEnv(config, record),
    };
  },
};
