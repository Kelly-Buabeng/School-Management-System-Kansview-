/**
 * Connection status: combines navigator.onLine with what actually happened to our requests.
 * Browsers often say "online" on a dead Wi-Fi or a captive portal, so a failed fetch also counts.
 */
type Listener = (online: boolean) => void;

class NetworkStatus {
  private browserOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
  private requestsFailing = false;
  private listeners = new Set<Listener>();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.browserOnline = true;
        this.emit();
      });
      window.addEventListener('offline', () => {
        this.browserOnline = false;
        this.emit();
      });
    }
  }

  get online() {
    return this.browserOnline && !this.requestsFailing;
  }

  reportFailure() {
    if (!this.requestsFailing) {
      this.requestsFailing = true;
      this.emit();
    }
  }

  reportSuccess() {
    if (this.requestsFailing) {
      this.requestsFailing = false;
      this.emit();
    }
  }

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit() {
    for (const l of this.listeners) l(this.online);
  }
}

export const networkStatus = new NetworkStatus();
