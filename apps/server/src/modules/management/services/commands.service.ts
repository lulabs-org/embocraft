import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { CommandRouter } from './command-router.service';

/** Shared HTTP write receipts. Reads and event subscriptions never enter this queue. */
export class ManagementCommands extends CommandRouter {
  constructor(
    private receiptBody: (body: unknown) => unknown = (body) => body ?? {},
  ) {
    super();
  }

  execute<T>(
    req: Request,
    lane: string,
    action: (commandId: string) => Promise<T>,
    validate?: () => void,
  ) {
    const id = req.header('Idempotency-Key') ?? randomUUID();
    const body = this.receiptBody(req.body);
    return this.run(
      id,
      { method: req.method, path: req.path, body },
      lane,
      async () => {
        validate?.();
        return action(id);
      },
      validate,
    ) as Promise<T>;
  }
}
