export type DesktopEvent =
  | { type: 'window-added'; id: string }
  | { type: 'window-removed'; id: string }
  | { type: 'window-focused'; id: string }
  | { type: 'window-minimized'; id: string }
  | { type: 'window-restored'; id: string }
  | { type: 'start-menu-toggled'; open: boolean };

export interface DesktopEventBus {
  emit(event: DesktopEvent): void;
  subscribe(listener: (event: DesktopEvent) => void): () => void; // returns unsubscribe
}

export function createDesktopEventBus(): DesktopEventBus {
  const listeners = new Set<(event: DesktopEvent) => void>();

  return {
    emit(event: DesktopEvent): void {
      // Snapshot so subscribe/unsubscribe during emission cannot skip listeners.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // A broken subscriber must not prevent other subscribers from running.
        }
      }
    },
    subscribe(listener: (event: DesktopEvent) => void): () => void {
      listeners.add(listener);
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        listeners.delete(listener);
      };
    },
  };
}
