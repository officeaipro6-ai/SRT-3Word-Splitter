/**
 * CANONICAL production route table.
 *
 * This module is the single source of truth for "which surface does this URL
 * show?", and it is imported by BOTH the client entry (src/main.tsx) and the
 * server (server.ts) so the two can never disagree.
 *
 * The rule this exists to enforce:
 *
 *   /            -> the NEW multilingual "Odia SRT" application
 *   /admin[/...] -> the secure Admin Dashboard ONLY
 *   anything else-> 404. Never the transcription UI.
 *
 * Rationale: previously `app.get('*')` sent index.html for EVERY path, so any
 * URL (including /admin) rendered the full transcription application. There was
 * no route that could be pointed at by accident, and no route that could be
 * closed off either. Unknown paths are now a hard 404.
 */
export type RouteTarget = 'app' | 'admin' | 'not-found';

/**
 * Strip query string / fragment, resolve dot-segments, collapse duplicate
 * slashes, drop the trailing slash.
 *
 * Dot-segments are resolved rather than ignored so a crafted path such as
 * `/admin/../legacy` cannot be classified by its prefix.
 */
function normalizePath(pathname: string): string {
  if (typeof pathname !== 'string' || pathname === '') return '/';
  let p = pathname;
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  if (!p.startsWith('/')) p = '/' + p;

  const trailingSlash = p.length > 1 && p.endsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  let normalized = '/' + out.join('/');
  if (normalized === '//') normalized = '/';
  if (trailingSlash && normalized !== '/') normalized = normalized.replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}

/**
 * Resolve a URL pathname to its canonical surface.
 * Kept free of DOM/window access so it is unit-testable and reusable in Node.
 */
export function resolveRouteTarget(pathname: string): RouteTarget {
  const p = normalizePath(pathname);
  if (p === '/') return 'app';
  // The admin surface owns its whole subtree; nothing else lives under it.
  if (p === '/admin' || p.startsWith('/admin/')) return 'admin';
  return 'not-found';
}

/** Server-side helper: the SPA shell is served for these two targets only. */
export function servesAppShell(pathname: string): boolean {
  return resolveRouteTarget(pathname) !== 'not-found';
}
