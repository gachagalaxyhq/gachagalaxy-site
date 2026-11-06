// gg-paths: serve exact paths from our Pages site on gachagalaxy.io. Everything else is untouched.
const ORIGIN = 'https://gachagalaxy-site.pages.dev';
const PATHS = new Set(['/prices.json', '/robots.txt', '/sitemap.xml', '/favicon.ico', '/apple-touch-icon.png']);
// Exact HTML pages that live only on Pages (Dan's server does not forward them)
const PAGES = new Map([['/how-gacha-mark-works', '/how-gacha-mark-works/'], ['/how-gacha-mark-works/', '/how-gacha-mark-works/'], ['/cleancheck', '/cleancheck.html'], ['/check', '/check.html'], ['/check/', '/check.html']]);
const PREFIXES = ['/data/cc/', '/data/own-claims.json'];
export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (PAGES.has(u.pathname)) {
      const tgt = PAGES.get(u.pathname);
      if (!u.pathname.endsWith('/') && tgt.endsWith('/')) return Response.redirect(u.origin + tgt + u.search, 301);
      const p = await fetch(ORIGIN + PAGES.get(u.pathname), { cf: { cacheTtl: 300 } });
      if (!p.ok) return fetch(req);
      const ph = new Headers(p.headers);
      ph.set('cache-control', 'public, max-age=300');
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
