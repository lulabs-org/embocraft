import type { Express, RequestHandler } from 'express';
import { ManagementCommands } from '../services/commands.service';
import { installManagementRoutes } from './managements.routes';
import { installManagementJsonRoutes } from './management-policy';

export type ManagementHttpDependencies = {
  authenticate: RequestHandler;
  receiptBody: (body: unknown) => unknown;
  installRoutes: (app: Express, commands: ManagementCommands) => void;
};

/** Owns the shared management pipeline; composition supplies domain route installers. */
export function installManagementHttp(
  app: Express,
  deps: ManagementHttpDependencies,
) {
  const commands = new ManagementCommands(deps.receiptBody);
  installManagementJsonRoutes(
    app,
    ['/ai-characters', '/providers', '/tasks', '/task-runs', '/management'],
    deps.authenticate,
    () => {
      deps.installRoutes(app, commands);
      installManagementRoutes(app, commands);
    },
  );
}
