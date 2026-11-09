// V2 is prepared locally, NOT approved for public acceptance or deployment.
// Source review AND the database reconciliation gate are required to open intake.
const INTAKE_AVAILABLE = true; // Owner-approved 2026-11-07; free allowance closed at 10/10.
const SB = 'https://jknodjsmpjwocpljnohc.supabase.co';
const FREE_LIMIT = 10;
const evidence = { grader_record: 'not_checked', qr_match: 'not_checked', physical_authenticity: 'not_checked' };
const json = (body, status = 200) => new Response(JSON.stringify({
  ...body, paymentStatus: 'inactive', payUrl: null, evidence
}), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const unavailable = () => json({ ok: false, intakeStatus: 'unavailable', code: 'INTAKE_NOT_CONFIGURED', freeLeft: null,
  freeLimit: null, error: 'Request intake unavailable: database contract awaiting reconciliation and approval. No request saved.' }, 503);
const uncertain = () => json({ ok: false, intakeStatus: 'uncertain', code: 'REQUEST_UNCONFIRMED', error: 'Request status could not be confirmed. Retry with the same grader and cert; do not assume it was saved.' }, 502);

// Absolute deadlines cover headers AND streamed bodies. Do not await cancellation:
// an uncooperative peer's cancel promise must not hold the worker open either.
async function boundedJson(stream, maxBytes, signal) {
  const reader = stream?.getReader();
  if (!reader) throw new Error('Missing body');
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(new Error('Body deadline'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const chunks = []; let size = 0;
    for (let count = 0; ; count++) {
      if (count >= 256) throw new Error('Body chunk limit');
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new RangeError('Body size limit');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', abort);
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* no peer details */ }
  }
}

async function deadline(ms, operation) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Deadline')); }, ms);
  });
  try { return await Promise.race([operation(controller.signal), expired]); }
  finally { clearTimeout(timer); controller.abort(); }
}

// Dependency injection is for isolated tests; no request or environment value can
// change the production source gate. No service-role credential fallback.
export function createMarkIntake({ reviewed = false, fetcher = (...args) => fetch(...args), timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('Invalid deadline');
  async function rpc(env, name, args) {
    if (!env?.MARK_INTAKE_RPC_TOKEN || !env?.MARK_INTAKE_API_KEY || !env?.MARK_INTAKE_GATE) return null;
    return deadline(timeoutMs, async signal => {
      const response = await fetcher(SB + '/rest/v1/rpc/' + name, {
      method: 'POST', signal,
      headers: { apikey: env.MARK_INTAKE_API_KEY, Authorization: 'Bearer ' + env.MARK_INTAKE_RPC_TOKEN,
        'content-type': 'application/json' }, body: JSON.stringify({ ...args, p_token: env.MARK_INTAKE_GATE })
      });
      if (!response.ok) {
        try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* discard */ }
        return { ok: false, status: response.status };
      }
      return { ok: true, data: await boundedJson(response.body, 4096, signal) };
    });
  }
  const validState = d => d && !Array.isArray(d) && d.contract === 'mark-intake-v2' &&
    d.policy_scope === 'global' && d.freeLimit === FREE_LIMIT &&
    Number.isInteger(d.remaining) && d.remaining >= 0 && d.remaining <= FREE_LIMIT;

  return {
    async onRequestPost({ request, env }) {
      let body;
      try {
        body = await deadline(timeoutMs, signal => boundedJson(request.body, 4096, signal));
      } catch (error) {
        return error instanceof RangeError ? json({ ok: false, error: 'Request too large.' }, 413)
          : json({ ok: false, error: 'Bad request.' }, 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          typeof body.cert !== 'string' || body.cert.length > 64 || !/^[0-9\s-]+$/.test(body.cert) ||
          (body.grader != null && typeof body.grader !== 'string') || typeof body.email !== 'string') {
        return json({ ok: false, error: 'Invalid request fields.' }, 400);
      }
      const cert = body.cert.replace(/[\s-]/g, '').replace(/^0+(?=\d)/, '');
      const grader = (body.grader == null ? 'PSA' : body.grader).trim().toUpperCase();
      const email = body.email.trim().toLowerCase();
      if (!/^[1-9][0-9]{5,9}$/.test(cert)) return json({ ok: false, error: 'That cert number does not look right.' }, 400);
      if (!['PSA', 'CGC'].includes(grader)) return json({ ok: false, error: 'Unsupported grader.' }, 400);
      if (email.length > 254 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]{2,}$/.test(email)) {
        return json({ ok: false, error: 'That email does not look right.' }, 400);
      }
      if (!reviewed) {
        if (grader === 'CGC') return json({ ok: false, error: 'CGC request intake is not available. Grader-scoped storage has not been confirmed.' }, 503);
        return unavailable();
      }
      try {
        const r = await rpc(env, 'claim_mark_v2', { p_grader: grader, p_cert: cert, p_email: email });
        if (!r) return unavailable();
        if (!r.ok) return r.status === 409 ? unavailable() : uncertain();
        const d = r.data;
        if (!validState(d) || typeof d.free !== 'boolean' || typeof d.existing !== 'boolean' ||
            typeof d.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(d.id) ||
            d.grader !== grader || d.cert !== cert || d.status !== 'requested') return uncertain();
        return json({ ok: true, intakeStatus: 'accepted', id: d.id, cert, grader, free: d.free,
          remaining: d.remaining, freeLimit: d.freeLimit, allowanceScope: d.policy_scope,
          existing: d.existing, status: d.status });
      } catch { return uncertain(); }
    },
    async onRequestGet({ env }) {
      if (!reviewed) return unavailable();
      try {
        const r = await rpc(env, 'mark_intake_status_v2', {});
        if (!r?.ok) return unavailable();
        const d = r.data;
        if (!validState(d)) return unavailable();
        return json({ ok: true, intakeStatus: 'available', supportedGraders: ['PSA', 'CGC'],
          freeLeft: d.remaining, freeLimit: d.freeLimit, allowanceScope: d.policy_scope });
      } catch { return unavailable(); }
    }
  };
}

const intake = createMarkIntake({ reviewed: INTAKE_AVAILABLE });
export const onRequestPost = intake.onRequestPost;
export const onRequestGet = intake.onRequestGet;
