/**
 * Mock-only controls for demonstrating unreliable internet.
 * - normal: everything works
 * - offline: every request fails as if the network is down
 * - lose-next-save: the next save IS stored on the "server", but the answer never reaches the browser
 *   (this is the dangerous case the "Not sure it saved" flow exists for)
 * - slow: every request waits 4 seconds
 */
export type FlakeMode = 'normal' | 'offline' | 'lose-next-save' | 'slow';

type Listener = (mode: FlakeMode) => void;

export const mockControl = {
  mode: 'normal' as FlakeMode,
  /** Extra delay for every request (ms); small in the browser so loading states are visible. */
  latencyMs: 0,
  listeners: new Set<Listener>(),
  setMode(mode: FlakeMode) {
    this.mode = mode;
    for (const l of this.listeners) l(mode);
  },
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  },
};
