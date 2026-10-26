// /verify/<grader>/<cert> — a real page (not a #hash) so X, Telegram, Slack and iMessage can build a
// link preview with the certificate's own image. Humans are sent on to the platform certificate page.
const SB = "https://jknodjsmpjwocpljnohc.supabase.co";
const SB_KEY = "sb_publishable_zuvJafFZrz4JStpgfljeUQ_Lj5l-05E";
const HOST = "https://gachagalaxy.io";
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const money = v => "$" + Math.round(Number(v) || 0).toLocaleString("en-US");

export function shareHtml(row, grader, cert) {
  const name = `${row.card_name || ""} ${row.card_no ? "#" + row.card_no : ""}`.trim();
  const title = name ? `${name} · Gacha Mark` : `Gacha Mark · PSA ${cert}`;
  const bits = [row.set_name, row.year, row.grade].filter(Boolean);
  const desc = bits.join(" · ") + (row.point_usd != null ? ` · value point ${money(row.point_usd)}` : "") +
    " · checked against the onchain registry. Asking prices, not completed sales.";
  const url = `${HOST}/verify/${encodeURIComponent(grader)}/${encodeURIComponent(cert)}`;
  const img = row.cert ? `${HOST}/og/${encodeURIComponent(cert)}.png` : `${HOST}/og-image-new.png`;
  const target = `${HOST}/platform#/cert/${encodeURIComponent(cert)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="noindex,follow">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Gacha Galaxy">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(title)} certificate">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
<style>html,body{margin:0;height:100%;background:#07060d;color:#fff;font:16px/1.5 system-ui,sans-serif}main{min-height:100%;display:grid;place-items:center;text-align:center;padding:32px}a{color:#b44dfa}</style>
</head><body><main><div><h1 style="font-size:22px;margin:0 0 8px">${esc(title)}</h1>
<p style="color:#c9d4e2;margin:0 0 16px">${esc(bits.join(" · "))}</p>
<p><a href="${esc(target)}">Open the certificate</a></p></div></main></body></html>`;
}

export async function onRequestGet({ params }) {
  const grader = String(params.grader || "").toUpperCase().slice(0, 8);
  const cert = String(params.cert || "").replace(/\D/g, "").slice(0, 12);
  if (!cert) return new Response("Not found", { status: 404 });
  const q = `${SB}/rest/v1/marks?grader=eq.${encodeURIComponent(grader)}&cert=eq.${encodeURIComponent(cert)}&select=*&limit=1`;
  let row = null;
  try {
    const r = await fetch(q, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    if (r.ok) row = (await r.json())[0] || null;
  } catch (e) { row = null; }
  if (!row) return Response.redirect(`${HOST}/platform#/certified`, 302);
  return new Response(shareHtml(row, grader, cert), {
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "public, max-age=300" }
  });
}
