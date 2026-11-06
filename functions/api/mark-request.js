// Public "Request a Gacha Mark" intake. Writes to Supabase mark_requests with the service role.
// The first FREE_LIMIT requests are free; claim_mark() counts and inserts in one transaction.
const SB = 'https://jknodjsmpjwocpljnohc.supabase.co';
const FREE_LIMIT = 10;

const json = (body, status) => new Response(JSON.stringify(body), {
  status: status || 200,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

function svc(env) { return env.SUPABASE_SERVICE_KEY; }

async function remaining(env) {
  const key = svc(env);
  if (!key) return null;
  const r = await fetch(SB + '/rest/v1/mark_requests?select=free&free=is.true', {
    headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'count=exact' }
  });
  if (!r.ok) return null;
  const cr = r.headers.get('content-range') || '';
  const used = Number((cr.split('/')[1] || '0'));
  return Math.max(FREE_LIMIT - (Number.isFinite(used) ? used : 0), 0);
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'Bad request.' }, 400); }

  const cert = String(body.cert || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  const grader = String(body.grader || 'PSA').toUpperCase() === 'CGC' ? 'CGC' : 'PSA';
  const email = String(body.email || '').trim().toLowerCase();

  if (cert.length < 6 || cert.length > 10) return json({ ok: false, error: 'That cert number does not look right.' }, 400);
  if (!isEmail(email)) return json({ ok: false, error: 'That email does not look right.' }, 400);

  const key = svc(env);
  if (!key) return json({ ok: false, error: 'Requests are not open just now.' }, 503);

  const r = await fetch(SB + '/rest/v1/rpc/claim_mark', {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ p_cert: cert, p_reason: 'web request \u00b7 ' + grader + ' \u00b7 ' + email, p_limit: FREE_LIMIT })
  });

  if (r.ok) {
    const d = await r.json().catch(() => ({}));
    return json({ ok: true, cert: cert, grader: grader, free: !!d.free, remaining: d.remaining, existing: !!d.existing });
  }
  const detail = (await r.text()).slice(0, 160);
  return json({ ok: false, error: 'Could not save the request.', detail: detail }, 502);
}

export async function onRequestGet({ env }) {
  const left = await remaining(env);
  if (left === null) return json({ ok: false, freeLeft: null, freeLimit: FREE_LIMIT }, 503);
  return json({ ok: true, freeLeft: left, freeLimit: FREE_LIMIT });
}
