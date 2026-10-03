// Gacha Galaxy - Cloudflare routing rule (stage 1)
// Attach to: gachagalaxy.io/* and www.gachagalaxy.io/*
// Dan's OVH server is not changed. DNS and email are not changed.
const PAGES = "https://gachagalaxy-site.pages.dev"; // new site on Cloudflare Pages

// These keep going to Dan's server exactly as today (not used by the new site)
const OVH_PATHS = ["/static", "/app/api"];
// These old pages now send visitors to the new platform (302 = easy to undo)
const TO_PLATFORM = ["/app", "/alpha"];

const match = (path, list) => list.some(p => path === p || path.startsWith(p + "/"));

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Old static files and Dan's API: pass through to OVH, unchanged
    if (match(path, OVH_PATHS)) return fetch(request);

    // 2. Old app and alpha pages: send to the new platform
    if (match(path, TO_PLATFORM)) return Response.redirect(url.origin + "/platform", 302);

    // 3. Everything else: new site on Cloudflare Pages
    const target = new URL(path + url.search, PAGES);
    return fetch(new Request(target, request));
  }
};
