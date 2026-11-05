import { AppError } from '../../../core/errors/app-error';
import type { TaskPort } from '../ports';

let activeTasks: TaskPort | undefined;

export function bindTaskService(tasks: TaskPort): () => void {
  activeTasks = tasks;
  return () => {
    if (activeTasks === tasks) activeTasks = undefined;
  };
}

export function getActiveTaskService(): TaskPort {
  if (!activeTasks) throw new AppError('任务服务尚未就绪。', 503);
  return activeTasks;
}

