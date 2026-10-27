import type { Express, RequestHandler } from 'express';
import {
  installAICharacterRoutes,
  type AICharacterRoutePort,
} from '../modules/ai-characters';
import {
  ManagementCommands,
  installManagementRoutes,
} from '../modules/management';
import {
  installProviderRoutes,
  type ProviderRouteDependencies,
} from '../modules/providers';
import {
  taskCommandBody,
  installTaskRoutes,
  type TaskPort,
} from '../modules/tasks';
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
