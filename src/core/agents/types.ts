import type { AgentProfile, AppConfig } from '../../types.js';
import type { PersonalSessionRecord } from '../sessions/registry.js';

export interface AgentCapabilities {
  prompt: boolean;
  steer: boolean;
  history: boolean;
  contextUsage: boolean;
}

export interface AgentRunner {
  readonly capabilities: AgentCapabilities;
  start(): void;
  isRunning(): boolean;
  promptAndWait(message: string): Promise<string>;
  waitForSettled(timeoutMs?: number): Promise<void>;
  steer(message: string): Promise<{ disposition: 'started' | 'queued' | 'handled' }>;
  /** Delivery mode for steering messages; only backends with a live channel implement it. */
  setSteeringMode?(mode: 'all' | 'one-at-a-time'): Promise<void>;
  getState(): Promise<unknown>;
  getMessages(): Promise<unknown>;
  getContextUsage(): Promise<{ text: string; source: string }>;
  close(): void;
}

export interface AgentProcess {
  command: string;
  args: string[];
  stdin?: string;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
}

export interface AgentAdapter {
  readonly sessionCapabilities: AgentCapabilities;
  createMainRunner(
    config: AppConfig,
    profile: AgentProfile,
    record?: PersonalSessionRecord,
  ): AgentRunner;
  sessionProcess(
    config: AppConfig,
    profile: AgentProfile,
    record: PersonalSessionRecord,
    prompt: string,
  ): AgentProcess | string;
  /**
   * A child session that stays addressable while it runs, so a steering message can
   * reach the live agent. Without it a session is a one-shot process with no channel.
   */
  createSessionRunner?(
    config: AppConfig,
    profile: AgentProfile,
    record: PersonalSessionRecord,
  ): AgentRunner;
}

export function unsupportedCapability(backend: string, capability: string): Error {
  return new Error(`agent backend ${backend} does not support ${capability}`);
}
