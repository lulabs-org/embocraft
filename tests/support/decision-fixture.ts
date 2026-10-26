import type { AgentDecision } from './decision-contracts';
/** Legacy JSON response fixtures drive the current task policy without a real model/network. */
import { aiCharacterPermissions } from '@voxel/shared';
import type {
  AgentConfig,
  ModelEndpoint,
  Observation,
} from '../../packages/agent-runtime/src/contracts';
import type { RequestAccounting } from '../../packages/agent-runtime/src/agent/model/charge';
import { AgentRuntimeError } from '../../packages/agent-runtime/src/contracts/errors';
import { parseDecision } from './decision-decision';
import { buildMessages } from './decision-prompts';
import { runTaskStep } from './decision-step';
import { resolveMaxTokensField } from '../../packages/agent-runtime/src/agent/model/pi';
import type { RunOptions } from '../../packages/agent-runtime/src/api/runtime';
export interface Planner {
  decide(
    observation: Observation,
    previous: unknown,
    signal: AbortSignal,
    budget?: RequestAccounting,
  ): Promise<AgentDecision>;
  lastUsage?: { tokens: number; estimated: boolean };
  managesRequests?: boolean;
}
export class DecisionFixture implements Planner {
  lastUsage?: { tokens: number; estimated: boolean };
  constructor(
    private config: AgentConfig,
    private request: typeof fetch,
    private endpoint: ModelEndpoint = {
      type: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
    },
  ) {}
  async decide(
    observation: Observation,
    previous: unknown,
    signal: AbortSignal,
  ): Promise<AgentDecision> {
    if (signal.aborted) throw new AgentRuntimeError('Agent 已停止。', true);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs);
    const combined = AbortSignal.any([signal, timeout.signal]);
    let onAbort!: () => void;
    try {
      const body = {
        model: this.config.model,
        stream: false,
        ...(this.endpoint.type === 'deepseek'
          ? {
              response_format: { type: 'json_object' },
              thinking: { type: this.config.thinking },
              ...(this.config.thinking === 'enabled'
                ? { reasoning_effort: this.config.reasoningEffort }
                : {}),
            }
          : {}),
        [resolveMaxTokensField(this.config.model)]: this.config.maxTokens,
        messages: buildMessages(observation, previous, this.config),
      };
      this.lastUsage = {
        tokens:
          Math.ceil(JSON.stringify(body.messages).length / 2) +
          this.config.maxTokens,
        estimated: true,
      };
      const response = await Promise.race([
        this.request(
          this.endpoint.baseUrl.replace(/\/$/, '') + '/chat/completions',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.config.apiKey || 'ollama'}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: combined,
            redirect: 'error',
          },
        ),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('aborted'));
          combined.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      if (!response.ok)
        throw new AgentRuntimeError(
          `${this.endpoint.type === 'deepseek' ? 'DeepSeek' : '模型服务'} HTTP ${response.status}：${response.status === 401 ? 'API Key 无效' : '服务暂不可用'}。`,
          [400, 401, 402, 403, 404, 422].includes(response.status),
        );
      const data = await response.json();
      combined.throwIfAborted();
      if (Number.isFinite(data.usage?.total_tokens))
        this.lastUsage = { tokens: data.usage.total_tokens, estimated: false };
      const c = data.choices?.[0];
      if (c?.finish_reason !== 'stop' || !c.message?.content?.trim())
        throw new AgentRuntimeError('模型未返回完整 JSON 动作，本轮跳过。');
      let value;
      try {
        value = JSON.parse(c.message.content);
      } catch {
        throw new AgentRuntimeError('模型返回的 JSON 无法解析，本轮跳过。');
      }
      try {
        return parseDecision(value, aiCharacterPermissions(this.config));
      } catch (e) {
        throw new AgentRuntimeError(
          `模型返回格式无效：${(e as Error).message}`,
        );
      }
    } catch (e) {
      if (e instanceof AgentRuntimeError) throw e;
      throw new AgentRuntimeError(
        signal.aborted
          ? 'Agent 已停止。'
          : timeout.signal.aborted
            ? '模型请求超时，本轮跳过。'
            : '无法获得有效的模型动作，本轮跳过。',
        signal.aborted,
      );
    } finally {
      clearTimeout(timer);
      combined.removeEventListener('abort', onAbort);
    }
  }
}
export function fixtureRunnerFactory<T>(
  factory: (config: AgentConfig, provider: T) => Planner,
) {
  return (config: AgentConfig, provider: T) => ({
    run: async (o: RunOptions) =>
      runTaskStep(
        o.session,
        factory(config, provider),
        o.config,
        o.signal,
        o.memory,
        o.attention,
        o.log,
        o.checkpoint,
        o.hooks,
      ),
  });
}
