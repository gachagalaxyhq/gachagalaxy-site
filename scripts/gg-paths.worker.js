// gg-paths: serve exact paths from our Pages site on gachagalaxy.io. Everything else is untouched.
const ORIGIN = 'https://gachagalaxy-site.pages.dev';
const PATHS = new Set(['/prices.json', '/robots.txt', '/sitemap.xml', '/favicon.ico', '/apple-touch-icon.png']);
// Exact HTML pages that live only on Pages (Dan's server does not forward them)
const PAGES = new Map([['/how-gacha-mark-works', '/how-gacha-mark-works/'], ['/how-gacha-mark-works/', '/how-gacha-mark-works/'], ['/cleancheck', '/cleancheck'], ['/check', '/check'], ['/check/', '/check'], ['/certificate', '/certificate'], ['/certificate/', '/certificate'], ['/platform', '/platform.html'], ['/platform/', '/platform.html'], ['/platform.html', '/platform.html']]);
const PREFIXES = ['/data/cc/', '/data/own-claims.json', '/data/catalogue/', '/data/catalogue-search.js', '/data/collector-evidence.json', '/cards/', '/assets/'];
export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/api/')) {
      const init = { method: req.method, headers: req.headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') init.body = req.body;
      return fetch(ORIGIN + u.pathname + u.search, init);
    }
    if (PAGES.has(u.pathname)) {
      const tgt = PAGES.get(u.pathname);
      if (!u.pathname.endsWith('/') && tgt.endsWith('/')) return Response.redirect(u.origin + tgt + u.search, 301);
      const pageInit = { headers: { 'cache-control': 'no-cache' }, cf: { cacheTtl: 0, cacheEverything: false } };
      let p = await fetch(ORIGIN + tgt, pageInit);
      // Pages issues 308 for .html and for slash variants; follow it ourselves so a
      // redirected target is never mistaken for a missing page.
      if (p.status >= 300 && p.status < 400) {
        const loc = p.headers.get('location');
        if (loc) p = await fetch(new URL(loc, ORIGIN).href, pageInit);
      }
      if (!p.ok) {
        const ph0 = new Headers(p.headers);
        ph0.set('x-gg-fallback', String(p.status));
        return new Response(p.body, { status: p.status, headers: ph0 });
      }
      const ph = new Headers(p.headers);
      ph.set('cache-control', 'no-store, max-age=0');
      ph.set('cdn-cache-control', 'no-store');
      ph.delete('etag');
      ph.delete('last-modified');
      ph.set('x-gg-worker', '1');
      return new Response(p.body, { status: 200, headers: ph });
    }
    const pref = PREFIXES.find(x => u.pathname === x || u.pathname.startsWith(x));
    if (!PATHS.has(u.pathname) && !pref) return fetch(req); // safety: pass through
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
