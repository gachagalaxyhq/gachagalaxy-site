// Gacha Galaxy - Cloudflare routing rule
// Attach to: gachagalaxy.io/* and www.gachagalaxy.io/*
// Dan's OVH server is not changed. These paths go to it exactly as today.
const PAGES = "https://gachagalaxy-site.pages.dev"; // Cloudflare Pages test address
const OVH_PATHS = ["/terms", "/privacy", "/risk-disclosure", "/static", "/app", "/alpha"];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    // 1. Legal pages, static files and Dan's /app: pass through to OVH, unchanged
    if (OVH_PATHS.some(p => path === p || path.startsWith(p + "/"))) {
      return fetch(request);
    }
    // 2. Everything else: new site on Cloudflare Pages
    const target = new URL(path + url.search, PAGES);
    return fetch(new Request(target, request));
  }
};
