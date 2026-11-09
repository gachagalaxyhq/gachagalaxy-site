// Price Check: one upstream lookup per submitted search; the key stays server-side.
// Provider sold aggregates may combine marketplaces and reporting windows.
export async function onRequestGet({request, env}) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  if (q.length < 3) return json({error: 'Type at least three characters.'}, 400);
  if (!env || !env.PPT_KEY) return json({error: 'Lookup is not configured.'}, 503);
  const u = `https://www.pokemonpricetracker.com/api/v2/cards?search=${encodeURIComponent(q)}&limit=12&includeEbay=true`;
  try {
  const r = await fetch(u, {headers: {Authorization: `Bearer ${env.PPT_KEY}`}});
  if (!r.ok) return json({error: 'Lookup is unavailable right now.'}, 502);
  const d = await r.json();
  if (!d || !Array.isArray(d.data)) throw new Error('Invalid card data');
  const cards = d.data.map(c => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('Invalid card');
    const g = (c.ebay && c.ebay.salesByGrade) || {};
    const f = k => {
      if (g[k] == null) return null;
      const sold = g[k];
      if (!Number.isSafeInteger(sold.count) || sold.count < 1 ||
          ![sold.medianPrice, sold.minPrice, sold.maxPrice].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0) ||
          sold.minPrice > sold.medianPrice || sold.medianPrice > sold.maxPrice) throw new Error('Invalid sold data');
      return {median: g[k].medianPrice, min: g[k].minPrice, max: g[k].maxPrice, n: g[k].count,
        last: g[k].lastSaleDate, mkt: (g[k].smartMarketPrice || {}).price,
        conf: (g[k].smartMarketPrice || {}).confidence,
        updated: typeof sold.lastMarketUpdate === 'string' && Number.isFinite(Date.parse(sold.lastMarketUpdate)) ? sold.lastMarketUpdate : null,
        sources: sold.salesBySource && typeof sold.salesBySource === 'object' && !Array.isArray(sold.salesBySource) &&
          Object.values(sold.salesBySource).every(v => Number.isSafeInteger(v) && v >= 0) ? sold.salesBySource : null};
    };
    return {name: c.name, set: c.setName, number: c.cardNumber, image: c.imageUrl || c.image || null,
      psa10: f('psa10'), psa9: f('psa9'), raw: f('ungraded')};
  }).filter(c => c.psa10 || c.psa9 || c.raw);
  return json({cards, attribution: 'Sold aggregates via PokemonPriceTracker; marketplaces and dates shown per grade.'});
  } catch (e) {
    return json({error: 'Lookup is unavailable right now.'}, 502);
  }
}
function json(o, s = 200) {
  return new Response(JSON.stringify(o), {status: s, headers: {'content-type': 'application/json', 'cache-control': s === 200 ? 'public, max-age=300' : 'no-store'}});
}
