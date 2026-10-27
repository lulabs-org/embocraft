/** Timer only selects due work. AICharacterWakeScheduler manages timers for characters. */
export class AICharacterWakeScheduler {
  private characters = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  cancel(id: string) {
    clearTimeout(this.characters.get(id));
    this.characters.delete(id);
  }

  wake(id: string, ms: number, action: () => void) {
    this.cancel(id);
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.characters.delete(id);
      action();
    }, ms);
    timer.unref();
    this.characters.set(id, timer);
  }

  close() {
    this.stopped = true;
    for (const id of this.characters.keys()) this.cancel(id);
  }
}
