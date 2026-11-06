// Public "Request a Gacha Mark" intake. Writes to Supabase mark_requests with the service role.
// No auth needed: a request is just an expression of interest in marking a cert.
const SB = 'https://jknodjsmpjwocpljnohc.supabase.co';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'Bad request.' }, 400);
  }

  const cert = String(body.cert || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  const grader = String(body.grader || 'PSA').toUpperCase() === 'CGC' ? 'CGC' : 'PSA';
  const email = String(body.email || '').trim().toLowerCase();

  if (cert.length < 5 || cert.length > 12) return json({ ok: false, error: 'That cert number does not look right.' }, 400);
  if (!isEmail(email)) return json({ ok: false, error: 'That email does not look right.' }, 400);

  const key = env.SUPABASE_SERVICE_KEY;
  if (!key) return json({ ok: false, error: 'Requests are not open just now.' }, 503);

  const row = {
    psa_cert: cert,
    status: 'pending',
    reason: 'web request \u00b7 ' + grader + ' \u00b7 ' + email
  };

  const r = await fetch(SB + '/rest/v1/mark_requests?on_conflict=psa_cert', {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'content-type': 'application/json',
      Prefer: 'return=minimal,resolution=merge-duplicates'
    },
    body: JSON.stringify(row)
  });

  if (r.ok) return json({ ok: true, cert: cert, grader: grader });
  // A cert already queued is not an error from the visitor's point of view
  if (r.status === 409) return json({ ok: true, cert: cert, grader: grader, existing: true });
  const detail = (await r.text()).slice(0, 200);
  return json({ ok: false, error: 'Could not save the request.', detail: detail }, 502);
}

export async function onRequestGet() {
  return json({ ok: false, error: 'POST a cert number, grader and email.' }, 405);
}
