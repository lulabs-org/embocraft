import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { CommandRouter } from '../../../core/concurrency/command-router';

/** Shared HTTP write receipts for console sync. Reads and event subscriptions never enter this queue. */
export class ConsoleSyncCommands extends CommandRouter {
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
    const path = req.baseUrl ? `${req.baseUrl}${req.path}` : req.path;
    return this.run(
      id,
      { method: req.method, path, body },
      lane,
      async () => {
        validate?.();
        return action(id);
      },
      validate,
    ) as Promise<T>;
  }
}
