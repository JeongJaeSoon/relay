export type RuntimeCleanup = () => void;

/** Owns process-local resources acquired during boot. Cleanup is reverse-order and exactly once. */
export class RuntimeLifecycle {
  private cleanups: RuntimeCleanup[] = [];
  private stopped = false;

  constructor(private onCleanupError: (error: unknown) => void = () => {}) {}

  add(cleanup: RuntimeCleanup) {
    if (this.stopped) {
      cleanup();
      return;
    }
    this.cleanups.push(cleanup);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const cleanup of this.cleanups.reverse()) {
      try { cleanup(); } catch (error) { this.onCleanupError(error); }
    }
    this.cleanups = [];
  }
}

export interface SignalSource {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

/** Installs the two service shutdown handlers and returns their removal callback. */
export function installShutdownSignals(source: SignalSource, shutdown: () => void, exit: (code: number) => void) {
  const handler = () => { shutdown(); exit(0); };
  source.on("SIGTERM", handler);
  source.on("SIGINT", handler);
  return () => {
    source.off("SIGTERM", handler);
    source.off("SIGINT", handler);
  };
}
