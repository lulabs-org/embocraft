/** Public business failures. Raw provider/configuration errors must never reach clients. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}
