// gg-paths: serve exact paths from our Pages site on gachagalaxy.io. Everything else is untouched.
const ORIGIN = 'https://gachagalaxy-site.pages.dev';
const PATHS = new Set(['/prices.json', '/robots.txt', '/sitemap.xml', '/favicon.ico', '/apple-touch-icon.png']);
export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (!PATHS.has(u.pathname)) return fetch(req); // safety: pass through
    const r = await fetch(ORIGIN + u.pathname, { cf: { cacheTtl: 300 } });
    // Pages returns the homepage for missing files; only serve a real, non-HTML file
    if (!r.ok || (r.headers.get('content-type') || '').includes('text/html')) return fetch(req);
    const h = new Headers(r.headers);
    h.set('cache-control', 'public, max-age=300');
    h.set('access-control-allow-origin', '*');
    h.set('x-gg-worker', '1');
    return new Response(r.body, { status: 200, headers: h });
  }
};
