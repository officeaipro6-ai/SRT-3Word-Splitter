import React from 'react';

/**
 * Shown for any URL that is not `/` and not `/admin`.
 *
 * This exists so an unknown/legacy URL can NEVER fall through to the
 * transcription UI. Previously `app.get('*')` returned index.html for every
 * path, so a stale bookmark showed the old screen.
 */
export const RouteNotFound: React.FC = () => (
  <div className="min-h-screen bg-slate-100 flex items-center justify-center px-4">
    <div className="max-w-md w-full bg-white border border-slate-200 rounded-2xl p-8 text-center shadow-sm">
      <div className="text-4xl font-black text-slate-300 mb-2">404</div>
      <h1 className="text-lg font-bold text-slate-900 mb-1">Page not found</h1>
      <p className="text-sm text-slate-500 mb-6">
        This address is not part of the application.
      </p>
      <a
        href="/"
        className="inline-block px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors"
      >
        Go to the app
      </a>
    </div>
  </div>
);
