import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './app/global.css';
import { createRoot } from 'react-dom/client';
import { API_MODE } from './api/client';
import { App } from './app/App';

async function boot() {
  if (API_MODE === 'mock') {
    // Loaded only in mock mode, in its own chunk: never part of a real-API build's startup code.
    const { startMockApi } = await import('./mocks/browser');
    await startMockApi();
  }
  createRoot(document.getElementById('root')!).render(<App />);
}

void boot();
