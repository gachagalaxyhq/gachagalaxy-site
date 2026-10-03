# gachagalaxy-site

Public website and platform for Gacha Galaxy. Cards and prices come from Collector Crypt listings only.

- `public/` is the site Cloudflare Pages serves (build output directory: `public`, no build command).
- `.github/workflows/refresh.yml` refreshes prices every 4 hours: fetch → build `data/cc.json` → history → render pages → commit.
- If a fetch looks bad (fewer than 100 cards, or bad prices), the last good `data/cc.json` is kept.
- `worker.js` is the routing rule for gachagalaxy.io. `/terms`, `/privacy`, `/risk-disclosure`, `/static/` and `/app` keep going to the existing server.

Undo: remove the routing rule in Cloudflare. The current site comes back straight away.
