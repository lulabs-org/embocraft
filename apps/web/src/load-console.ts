export async function loadControlConsole() {
  const { ControlConsole } = await import('./features/console');
  return { default: ControlConsole };
}

export function preloadConsole() {
  // Import deduplicates concurrent requests. A speculative failure must not
  // become an unhandled rejection or poison React.lazy's first real attempt.
  void loadControlConsole().catch(() => {});
}
