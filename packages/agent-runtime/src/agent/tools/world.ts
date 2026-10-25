import type { AgentTool } from '@earendil-works/pi-agent-core';
import { aiCharacterPermissions } from '@voxel/shared';
import { AgentRuntimeError } from '../../contracts/errors';
import { mergeSignals } from '../../kernel/abort';
import { isActiveTask } from '../task/state';
import { toolSchemas } from './schema';
import { createTaskTools } from './task';
import { executeTaskActions } from '../action/executor';
import { initialToolState } from '../../contracts/tool-state';
import { recordEvent } from '../task/inbox';
import type { ToolHost } from './port';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  details: {},
});

/**
 * Wraps task-scoped world tools with character-runner runtime concerns:
 * - Direct chat responses & task auto-attachment
 * - Observation refreshing
 * - Single-action execution mutual exclusion
 * - Background action launching & settlement event recording (goto, build, house)
 */
export function createRuntimeWorldTools(o: ToolHost): AgentTool[] {
  return Object.entries(toolSchemas).map(([name, parameters]) => ({
    name,
    label: name,
    parameters,
    description: ['goto', 'build', 'house'].includes(name)
      ? `Start ${name}; returns an action ID. Completion arrives as an action_result event. Never start a second action while one runs.`
      : `Use ${name} for the current authorized activity. If no task exists, first call start_task(goal); a world tool never creates a task implicitly.`,
    execute: async (id, value, ...rest) => {
      if (name === 'chat' && o.message) {
        const args = value as { text: string; relatedToTask?: boolean };
        await o.respond(args.text, args.relatedToTask);
        return result({ replied: true });
      }
      if (name === 'observe') {
        await o.observe();
        return result({
          observation: o.prepared().observation,
          activity: o.prepared().context,
        });
      }
      o.authorize();
      if (o.actionBusy())
        throw new AgentRuntimeError(
          '当前动作尚未结束，请读取进度或先明确停止。',
        );
      if (!isActiveTask(o.memory.task.current))
        throw new AgentRuntimeError(
          'No active running task. For a NEW human action request, call start_task(goal) FIRST, then retry the world tool. Do not claim completion: no world action was executed. A paused or exhausted task must be resumed, never recreated.',
        );
      o.attach();
      const lease = o.service.lease();
      const background = ['goto', 'build', 'house'].includes(name);
      const controller = new AbortController();
      const toolSignal = mergeSignals(o.activeSignal, controller.signal);
      const toolState = background ? initialToolState() : o.state;
      const taskTools = createTaskTools({
        state: toolState,
        memory: o.memory,
        service: o.service,
        lease,
        prepared: () => o.prepared(),
        observe: () => o.observe(),
        canChat: aiCharacterPermissions(o.config).chat,
        signal: toolSignal,
        save: () => o.save(),
        shouldYield: () => !background && !!o.attention?.pending,
        execute: async (action) => {
          const outcome = await executeTaskActions(
            o.session,
            [action],
            o.prepared().observation,
            o.config,
            toolSignal,
            o.memory,
            o.budget,
            lease,
            () => o.save(),
            background ? undefined : o.attention,
            o.log,
          );
          o.prepared().observation = {
            ...outcome.observation,
            attention: o.message,
          };
          await o.observe();
          return outcome.batch;
        },
      });
      const tool = taskTools.find((t) => t.name === name)!;
      if (!background) {
        const valueResult = await tool.execute(id, value, ...rest);
        if (name === 'follow' && o.memory.effects.follow)
          o.memory.effects.activeAction = {
            id,
            name,
            taskId: lease.id,
            revision: lease.revision,
            status: 'running',
          };
        return valueResult;
      }
      o.memory.effects.activeAction = {
        id,
        name,
        taskId: lease.id,
        revision: lease.revision,
        status: 'running',
      };
      await o.save();
      const work = Promise.resolve(tool.execute(id, value, ...rest))
        .then(
          (value) => {
            if (o.service.current(lease))
              o.memory.effects.activeAction = {
                id,
                name,
                taskId: lease.id,
                revision: lease.revision,
                status: 'completed',
                result: value,
              };
          },
          (error) => {
            if (o.service.current(lease))
              o.memory.effects.activeAction = {
                id,
                name,
                taskId: lease.id,
                revision: lease.revision,
                status: o.activeSignal.aborted ? 'unknown' : 'failed',
                result: String(error),
              };
          },
        )
        .then(async () => {
          if (o.service.current(lease))
            recordEvent(o.memory, {
              id: `action:${id}`,
              kind: 'action_result',
              state: 'pending',
              at: Date.now(),
              audience: o.memory.task.current?.privateTo ?? 'public',
              taskId: lease.id,
              revision: lease.revision,
              actionId: id,
            });
          await o.save();
        });
      o.launch(id, controller, work);
      o.state.terminal = true;
      return result({ actionId: id, status: 'running' });
    },
  }));
}
