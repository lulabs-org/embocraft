import type { Express, RequestHandler } from 'express';
import {
  installAICharacterRoutes,
  type AICharacterRoutePort,
} from '../modules/ai-characters/routes';
import { ManagementCommands } from '../modules/management/commands';
import { installManagementRoutes } from '../modules/management/routes';
import {
  installProviderRoutes,
  type ProviderRouteDependencies,
} from '../modules/providers/routes/providers.routes';
import { taskCommandBody } from '../modules/tasks/command-policy';
import type { TaskPort } from '../modules/tasks/port';
import { installTaskRoutes } from '../modules/tasks/routes';
import { installManagementJsonRoutes } from './management-policy';

export type ManagementHttpDependencies = {
  authenticate: RequestHandler;
  characters: AICharacterRoutePort;
  providers: ProviderRouteDependencies;
  tasks: TaskPort;
};

export function installManagementHttp(
  app: Express,
  deps: ManagementHttpDependencies,
) {
  const commands = new ManagementCommands(taskCommandBody);
  installManagementJsonRoutes(
    app,
    ['/ai-characters', '/providers', '/tasks', '/task-runs', '/management'],
    deps.authenticate,
    () => {
      installAICharacterRoutes(app, deps.characters, commands);
      installProviderRoutes(app, deps.providers, commands);
      installTaskRoutes(app, deps.tasks, commands);
      installManagementRoutes(app, commands);
    },
  );
}
