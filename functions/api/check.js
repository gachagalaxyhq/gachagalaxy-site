// Free card check: proxies one PokemonPriceTracker lookup per keystroke-pause, server-side so the key never ships.
// Returns only what the page draws: identity plus PSA 10 sold-comp stats.
export async function onRequestGet({request, env}) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  if (q.length < 3) return json({error: 'Type at least three characters.'}, 400);
  if (!env.PPT_KEY) return json({error: 'Lookup is not configured.'}, 503);
  const u = `https://www.pokemonpricetracker.com/api/v2/cards?search=${encodeURIComponent(q)}&limit=12&includeEbay=true`;
  const r = await fetch(u, {headers: {Authorization: `Bearer ${env.PPT_KEY}`}});
  if (!r.ok) return json({error: 'Lookup is unavailable right now.'}, 502);
  const d = await r.json();
  const cards = (d.data || []).map(c => {
    const g = (c.ebay && c.ebay.salesByGrade) || {};
    const f = k => g[k] ? {median: g[k].medianPrice, min: g[k].minPrice, max: g[k].maxPrice, n: g[k].count,
      last: g[k].lastSaleDate, mkt: (g[k].smartMarketPrice || {}).price,
      conf: (g[k].smartMarketPrice || {}).confidence} : null;
    return {name: c.name, set: c.setName, number: c.cardNumber, image: c.imageUrl || c.image || null,
      psa10: f('psa10'), psa9: f('psa9'), raw: f('ungraded')};
  }).filter(c => c.psa10 || c.psa9 || c.raw);
  return json({cards, attribution: 'Sold prices: eBay comps via PokemonPriceTracker'});
}
function json(o, s = 200) {
  return new Response(JSON.stringify(o), {status: s, headers: {'content-type': 'application/json', 'cache-control': 'public, max-age=300'}});
}
