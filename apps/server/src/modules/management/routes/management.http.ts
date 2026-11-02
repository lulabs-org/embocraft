import type { Express, RequestHandler } from 'express';
import { ManagementCommands } from '../services/commands.service';
import { installManagementRoutes } from './managements.routes';
import { ManagementScope } from './management-policy';

export const DEFAULT_MANAGEMENT_PATHS = [
  '/ai-characters',
  '/providers',
  '/tasks',
  '/task-runs',
  '/management',
];

export type ManagementHttpDependencies = {
  authenticate: RequestHandler;
  receiptBody: (body: unknown) => unknown;
  installRoutes: (app: Express, commands: ManagementCommands) => void;
  paths?: string | string[];
};

/**
 * Owns the shared management pipeline; composition supplies domain route installers.
 * @deprecated 推荐在 app.ts 中使用 ManagementScope 线性平铺注册
 */
export function installManagementHttp(
  app: Express,
  deps: ManagementHttpDependencies,
) {
  const commands = new ManagementCommands(deps.receiptBody);
  const scope = new ManagementScope(
    app,
    deps.paths ?? DEFAULT_MANAGEMENT_PATHS,
    deps.authenticate,
  );
  deps.installRoutes(app, commands);
  installManagementRoutes(app, commands);
  scope.close();
}
