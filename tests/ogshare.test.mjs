import test from 'node:test';import assert from 'node:assert';
import {shareHtml} from '../functions/verify/[grader]/[cert].js';
const row={cert:'111992917',card_name:'Umbreon VMAX',card_no:'TG23',set_name:'Brilliant Stars',year:2022,grade:'PSA 10',point_usd:275};
const h=shareHtml(row,'PSA','111992917');
test('absolute og:url and og:image',()=>{assert.match(h,/og:url" content="https:\/\/gachagalaxy.io\/verify\/PSA\/111992917"/);assert.match(h,/og:image" content="https:\/\/gachagalaxy.io\/og\/111992917.png"/);assert.match(h,/"twitter:card" content="summary_large_image"/)});
test('human redirect points at the certificate page',()=>assert.match(h,/url=https:\/\/gachagalaxy.io\/platform#\/cert\/111992917/));
test('escapes untrusted text',()=>{const bad=shareHtml({...row,card_name:'<script>alert(1)</script>'},'PSA','1');assert.ok(!bad.includes('<script>alert(1)</script>'));assert.ok(bad.includes('&lt;script&gt;'))});
test('no banned wording',()=>{for(const w of [/valid until/i,/testnet/i,/\blive\b/i])assert.doesNotMatch(h,w)});
test('missing row still yields sane defaults',()=>{const d=shareHtml({},'PSA','123');assert.match(d,/og:image" content="https:\/\/gachagalaxy.io\/og-image-new.png"/);assert.match(d,/Gacha Mark · PSA 123/)});

test('share page is noindex but keeps share tags', async () => {
  const mod = await import('../functions/verify/[grader]/[cert].js');
  const h = mod.shareHtml({ cert: '111992917', card_name: 'Umbreon VMAX', card_no: 'TG23', grade: 'PSA 10', low_usd: 249.02, point_usd: 275, high_usd: 300.98, confidence: 88 }, 'PSA', '111992917');
  assert.match(h, /<meta name="robots" content="noindex,follow">/);
  assert.match(h, /og:image" content="https:\/\/gachagalaxy\.io\/og\/111992917\.png/);
});

test('HEAD mirrors GET status and headers with no body', async () => {
  const mod = await import('../functions/verify/[grader]/[cert].js');
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{ cert: '111992917', card_name: 'Umbreon VMAX', grade: 'PSA 10', point_usd: 275 }]), { status: 200 });
  try {
    const r = await mod.onRequestHead({ params: { grader: 'PSA', cert: '111992917' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.equal(await r.text(), '');
    globalThis.fetch = async () => new Response('[]', { status: 200 });
    const m = await mod.onRequestHead({ params: { grader: 'PSA', cert: '999' } });
    assert.equal(m.status, 302);
  } finally { globalThis.fetch = real; }
});
