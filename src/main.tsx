import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {AdminApp} from './components/AdminApp.tsx';
import {RouteNotFound} from './components/RouteNotFound.tsx';
import {ErrorBoundary} from './components/ErrorBoundary.tsx';
import {resolveRouteTarget} from './routeTarget.ts';
import './index.css';

/**
 * Single entry point for the whole application.
 *
 * The route is resolved ONCE, before anything else mounts, so a given URL can
 * only ever render one surface:
 *
 *   /            -> <App/>      the new multilingual Odia SRT application
 *   /admin[/...] -> <AdminApp/> the secure Admin Dashboard, and nothing else
 *   anything else-> 404
 *
 * Because the transcription UI is never mounted on /admin, no production route
 * can display the legacy transcription screen.
 */
const target = resolveRouteTarget(window.location.pathname);

const surface =
  target === 'admin' ? <AdminApp /> : target === 'app' ? <App /> : <RouteNotFound />;

document.title =
  target === 'admin'
    ? 'Admin Dashboard — Odia SRT'
    : target === 'app'
      ? 'Odia SRT — Audio/Video → Tagged SRT'
      : 'Page not found — Odia SRT';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>{surface}</ErrorBoundary>
  </StrictMode>
);
