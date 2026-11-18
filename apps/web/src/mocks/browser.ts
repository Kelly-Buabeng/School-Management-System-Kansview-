import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import { mockControl } from './control';

export async function startMockApi() {
  mockControl.latencyMs = 250; // visible loading states, like a slow school network
  const worker = setupWorker(...handlers);
  await worker.start({ onUnhandledRequest: 'bypass', quiet: true, serviceWorker: { url: '/mockServiceWorker.js' } });
}
