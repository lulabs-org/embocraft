/** Runs only plan triggers; Agent wake timers are owned separately. */
export class TaskScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;
  constructor(private readonly tick: () => Promise<void>) {}
  start() {
    if (this.timer || this.stopped || this.running) return;
    this.timer = setTimeout(() => {
      void this.runTick();
    }, 1000);
    this.timer.unref();
  }
  private async runTick() {
    this.timer = undefined;
    this.running = true;
    try {
      await this.tick();
    } catch {
      /* Persistence errors never dispatch work. */
    } finally {
      this.running = false;
    }
    this.start();
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
