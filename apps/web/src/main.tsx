// Self-hosted fonts (latin + latin-ext only; the LAN is often offline, so no font CDN).
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-ext-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-ext-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/source-serif-4/latin-600.css';
import '@fontsource/source-serif-4/latin-ext-600.css';
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
