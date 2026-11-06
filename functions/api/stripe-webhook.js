// Stripe webhook: marks a paid mark_request as paid. No SDK — Web Crypto only.
const SB = 'https://jknodjsmpjwocpljnohc.supabase.co';

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

async function hmac(secret, payload) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verify(raw, header, secret) {
  if (!header || !secret) return false;
  const parts = {};
  header.split(',').forEach(kv => { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); });
  if (!parts.t || !parts.v1) return false;
  const expected = await hmac(secret, parts.t + '.' + raw);
  return same(expected, parts.v1);
}

const json = (b, s) => new Response(JSON.stringify(b), { status: s || 200, headers: { 'content-type': 'application/json' } });

export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  const ok = await verify(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return json({ ok: false, error: 'bad signature' }, 400);

  let evt;
  try { evt = JSON.parse(raw); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }

  if (evt.type !== 'checkout.session.completed' && evt.type !== 'checkout.session.async_payment_succeeded') {
    return json({ ok: true, ignored: evt.type });
  }

  const session = (evt.data && evt.data.object) || {};
  const id = String(session.client_reference_id || '').replace(/\D/g, '');
  if (!id) return json({ ok: true, ignored: 'no client_reference_id' });
  if (session.payment_status && session.payment_status !== 'paid') return json({ ok: true, ignored: 'unpaid ' + session.payment_status });

  const key = env.SUPABASE_SERVICE_KEY;
  if (!key) return json({ ok: false, error: 'no key' }, 503);

  const r = await fetch(SB + '/rest/v1/mark_requests?id=eq.' + id, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'content-type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ paid: true, paid_at: new Date().toISOString(), stripe_session: session.id || null })
  });
  if (!r.ok) return json({ ok: false, error: 'update failed', detail: (await r.text()).slice(0, 160) }, 502);
  const rows = await r.json().catch(() => []);
  return json({ ok: true, id: Number(id), paid: true, rows: rows.length });
}
