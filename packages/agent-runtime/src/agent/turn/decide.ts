import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type AgentTurnContext,
  type AgentTurnDecision,
} from '@earendil-works/pi-agent-core';
import {
  createInitialSystemMessage,
  type AssistantMessage,
  type Message,
} from '@earendil-works/pi-ai';
import type { ToolState } from '../../contracts/tool-state';
import { TOOL_PROTOCOL_CORRECTION } from '../prompt/system';
import type { AgentConfig, ModelEndpoint } from '../../contracts';
import { AgentRuntimeError } from '../../contracts/errors';
import { createModel } from '../model/pi';
import { createModelStream } from '../model/stream';
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
  sessionKey?: object;
  interactionHistory?: boolean;
  contextEpoch?: () => string;
};

/**
 * One reused Pi agent per character session.
 *
 * Pi captures the lifecycle callbacks when the agent is constructed, so the
 * callbacks read `this.options` at call time and `open()` swaps in the next
 * turn's options. That keeps one agent, and its transcript, alive across turns.
 */
class DecisionSession {
  private options: DecisionLoopOptions;
  private readonly agent: Agent;
  private readonly correction = new ToolProtocolCorrection();
  private contextEpoch: string | undefined;

  constructor(options: DecisionLoopOptions) {
    this.options = options;
    this.contextEpoch = options.contextEpoch?.();
    this.agent = this.createAgent();
    // Truncated and policy-blocked calls never reach afterToolCall, so the
    // event stream is the complete signal for a failed batch.
    this.agent.subscribe((event) => {
      if (event.type === 'tool_execution_end' && event.isError)
        failBatch(this.options.state);
    });
  }

  /** Advances a reused session to the next turn and clears per-turn guard state. */
  open(options: DecisionLoopOptions) {
    this.options = options;
    this.contextEpoch = options.contextEpoch?.();
    this.correction.reset();
  }

  /** Rebuilds the transcript and runs Pi until the loop ends or the host stops it. */
  async run(input: string) {
    const { agent } = this;
    const { budget, signal, state, transcript } = this.options;
    agent.reset();
    agent.state.model = createModel(this.options.config, this.options.endpoint);
    agent.state.tools = this.options.tools;
    agent.state.messages = [
      createInitialSystemMessage(this.options.prompt, this.options.tools)!,
      ...(this.options.history ?? []),
    ];

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
      },
      streamFn: (model, context, streamOptions) => {
        const { config, endpoint, budget, signal, request, save } =
          this.options;
        return createModelStream({
          config,
          endpoint,
          budget,
          signal,
          request,
          persistAdmission: save,
        })(model, context, streamOptions);
      },
      toolExecution: 'sequential',
      transformContext: (messages) => this.transformContext(messages),
      beforeToolCall: async ({ assistantMessage }) =>
        this.gateBatch(assistantMessage),
      afterToolCall: async ({ isError }) => {
        if (isError) failBatch(this.options.state);
        return undefined;
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

  /** Refuses the rest of a batch once it is stopped, truncated or out of time. */
  private async gateBatch(assistantMessage: AssistantMessage) {
    const block = toolBlockReason(
      this.options,
      assistantMessage.stopReason === 'length',
    );
    return block && { block: true, ...block };
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

const sessions = new WeakMap<object, DecisionSession>();

/** Runs the cognitive decision loop for the current character turn. */
export async function runDecisionLoop(options: DecisionLoopOptions) {
  await sessionFor(options).run(options.input);
}

/** Reuses the agent bound to the session key; unkeyed runs always get a fresh one. */
function sessionFor(options: DecisionLoopOptions): DecisionSession {
  const { sessionKey } = options;
  if (!sessionKey) return new DecisionSession(options);
  const cached = sessions.get(sessionKey);
  if (cached) {
    cached.open(options);
    return cached;
  }
  const session = new DecisionSession(options);
  sessions.set(sessionKey, session);
  return session;
}
