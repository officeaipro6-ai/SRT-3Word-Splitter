/**
 * API URL helper for consistent URL construction across web and Electron.
 *
 * In web mode: returns relative paths (e.g., '/api/session')
 * In Electron mode: returns absolute URLs using VITE_API_BASE_URL (e.g., 'https://api.example.com/api/session')
 */

function getApiBaseUrl(): string {
  // In Electron, VITE_API_BASE_URL is injected at build time
  const baseUrl = (import.meta.env.VITE_API_BASE_URL as string) || '';
  return baseUrl;
}

export function getApiUrl(path: string): string {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    // Web mode: use relative URL
    return path.startsWith('/') ? path : `/${path}`;
  }
  // Electron mode: use absolute URL
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedPath}`;
}

export function isElectron(): boolean {
  return import.meta.env.VITE_IS_ELECTRON === 'true';
}