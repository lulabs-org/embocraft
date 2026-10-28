import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type AgentTurnContext,
  type AgentTurnDecision,
} from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import type { ToolState } from '../../contracts/tool-state';
import { TOOL_PROTOCOL_CORRECTION } from '../prompt/character';
import type { AgentConfig, ModelEndpoint } from '../../contracts';
import { AgentRuntimeError } from '../../contracts/errors';
import { createModel } from '../model/pi';
import { streamModel } from '../model/stream';
import type { RequestBudget } from '../task/budget';
import {
  failBatch,
  toolBlockReason,
  ToolProtocolCorrection,
  turnEnded,
  turnStopped,
} from './guards';
import { decisionWindow } from './window';

/** Multi-step cognitive decision loop options for unified character event handling. */
export type DecisionLoopOptions = {
  config: AgentConfig;
  endpoint: ModelEndpoint;
  request: typeof fetch;
  budget: RequestBudget;
  signal: AbortSignal;
  state: ToolState;
  prompt: string;
  input: string;
  tools: AgentTool[];
  history?: Message[];
  save: () => Promise<void>;
  shouldYield: () => boolean;
  afterTurn?: () => void;
  transcript?: (messages: Message[]) => Promise<void>;
  interactionHistory?: boolean;
  contextEpoch?: () => string;
};

/** One Pi agent for this decision; persisted history is replayed into each run. */
class PiDecision {
  private readonly agent: Agent;
  private readonly correction = new ToolProtocolCorrection();
  private contextEpoch: string | undefined;

  constructor(private readonly options: DecisionLoopOptions) {
    this.contextEpoch = options.contextEpoch?.();
    this.agent = this.createAgent();
    // End events cover validation, blocked, truncated, and execution failures.
    this.agent.subscribe((event) => {
      if (event.type === 'tool_execution_end' && event.isError)
        failBatch(this.options.state);
    });
  }

  /** Runs Pi until this decision ends. */
  async run() {
    const { agent } = this;
    const { budget, signal, state, transcript, input } = this.options;
    const abort = () => agent.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await agent.prompt(input);
      if (agent.state.errorMessage && !signal.aborted)
        throw new AgentRuntimeError(agent.state.errorMessage);
      if (state.persistenceFailed)
        throw new AgentRuntimeError('无法保存任务检查点，已停止写操作。', true);
    } finally {
      signal.removeEventListener('abort', abort);
      budget.flushTime();
      if (!state.persistenceFailed)
        await transcript?.(agent.state.messages as Message[]);
    }
  }

  private createAgent(): Agent {
    return new Agent({
      initialState: {
        model: createModel(this.options.config, this.options.endpoint),
        systemPrompt: this.options.prompt,
        tools: this.options.tools,
        messages: this.options.history,
      },
      streamFn: (_model, context, streamOptions) => {
        const { config, endpoint, budget, signal, request, save } =
          this.options;
        return streamModel(
          {
            config,
            endpoint,
            budget,
            signal,
            request,
            persistAdmission: save,
          },
          context,
          streamOptions?.signal,
        );
      },
      toolExecution: 'sequential',
      transformContext: (messages) => this.transformContext(messages),
      beforeToolCall: async ({ assistantMessage }) => {
        const block = toolBlockReason(
          this.options,
          assistantMessage.stopReason === 'length',
        );
        return block && { block: true, ...block };
      },
      prepareRequest: () => this.beginRequest(),
      finishTurn: (turn) => this.finishTurn(turn),
    });
  }

  /** Clears the per-request flags, then persists the request admission. */
  private async beginRequest() {
    const { state, save } = this.options;
    state.turnMutated = false;
    state.skipBatch = false;
    state.hadError = false;
    await save();
  }

  /** Applies the session window and the one-shot protocol correction per request. */
  private async transformContext(
    messages: AgentMessage[],
  ): Promise<AgentMessage[]> {
    const epoch = this.options.contextEpoch?.();
    if (this.contextEpoch !== epoch) {
      // A new task revision invalidates the replayed transcript: keep the system
      // messages and start again from the current human input.
      this.contextEpoch = epoch;
      const lastInput = messages.map((m) => m.role).lastIndexOf('user');
      messages = messages.filter(
        (m, index) => m.role === 'system' || index >= lastInput,
      );
      this.agent.state.messages = messages;
    }
    const context = decisionWindow(
      messages as Message[],
      !!this.options.interactionHistory,
    );
    if (this.correction.take())
      context.push({
        role: 'user',
        content: [{ type: 'text', text: TOOL_PROTOCOL_CORRECTION }],
        timestamp: Date.now(),
      });
    return context;
  }

  /** Ends the run after a completed turn, or spends the one protocol correction. */
  private async finishTurn({
    message,
  }: AgentTurnContext): Promise<AgentTurnDecision> {
    const answersInProse =
      message.stopReason === 'stop' &&
      !message.content.some((part) => part.type === 'toolCall');
    if (answersInProse) {
      if (this.correctToolProtocol()) return { action: 'continue' };
      throw new AgentRuntimeError(
        '模型未返回工具调用；请使用支持原生工具调用的模型，本次运行已停止。',
      );
    }
    this.options.afterTurn?.();
    await this.options.transcript?.(this.agent.state.messages as Message[]);
    return turnEnded(this.options, message.stopReason)
      ? { action: 'end' }
      : { action: 'continue' };
  }

  /**
   * Models sometimes answer in prose after a tool result. Spend exactly one
   * nudge; a second prose answer fails the turn instead of being parsed as an action.
   */
  private correctToolProtocol(): boolean {
    if (!this.correction.available || turnStopped(this.options)) return false;
    this.correction.request();
    return true;
  }
}

/** Runs the cognitive decision loop for the current character turn. */
export async function runDecisionLoop(options: DecisionLoopOptions) {
  await new PiDecision(options).run();
}
