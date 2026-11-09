/* Offline public catalogue search. No third-party calls, QR or issuance. */
'use strict';
let manifest, indexPromise, active = 0;
const index = [];
async function getJSON(url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error('Saved search data unavailable');
  return response.json();
}
async function loadIndex(m) {
  if (manifest && manifest.version !== m.version) throw new Error('Catalogue snapshot changed; reload');
  manifest = m;
  if (!indexPromise) indexPromise = (async () => {
    let next = 0, complete = 0;
    const parts = new Array(m.search_shards.length);
    await Promise.all(Array.from({length: 3}, async () => {
      while (next < m.search_shards.length) {
        const number = next++, descriptor = m.search_shards[number];
        const rows = await getJSON(m.base_url + descriptor.file);
        if (!Array.isArray(rows) || rows.length !== descriptor.count || rows.some(r => !Array.isArray(r) || r.length !== 10)) throw new Error('Invalid saved search shard');
        parts[number] = rows;
        complete += rows.length;
        self.postMessage({type: 'progress', loaded: complete, total: m.total_records});
      }
    }));
    const eligible = new Set(m.decoded.refs.map(ref => ref.join(':')));
    let rawCount = 0;
    for (const rows of parts) for (const row of rows) {
      rawCount++;
      if (!eligible.has(row[7] + ':' + row[8])) continue;
      // Cache only the compact public search projection, not full listing data.
      index.push({ref: row, text: row.slice(0, 7).map(v => v ?? '').join(' ').toLowerCase()});
    }
    if (rawCount !== m.total_records || index.length !== m.decoded.decoded_records) throw new Error('Incomplete saved search index');
    const order = new Map(m.decoded.refs.map((ref, i) => [ref.join(':'), i]));
    index.sort((a,b) => order.get(a.ref[7]+':'+a.ref[8])-order.get(b.ref[7]+':'+b.ref[8]));
  })().catch(error => {index.length = 0; indexPromise = null; throw error;});
  return indexPromise;
}
function matches(row, words, grader, scan) {
  return (!grader || row.ref[4] === grader) &&
    // Legacy scan query parameters cannot broaden the decoded-only selection.
    words.every(word => row.text.includes(word));
}
self.onmessage = async ({data}) => {
  const {id, query = '', grader = '', scan = '', page = 0, pageSize = 40, manifest: m} = data;
  active = id;
  try {
    await loadIndex(m);
    if (active !== id) return;
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let count = 0;
    const refs = [], start = Math.max(0, page) * pageSize;
    for (const row of index) if (matches(row, words, grader, scan)) {
      if (count >= start && refs.length < pageSize) refs.push([row.ref[7], row.ref[8]]);
      count++;
    }
    if (active === id) self.postMessage({type: 'results', id, total: count, refs});
  } catch (error) {
    if (active === id) self.postMessage({type: 'error', id, message: 'Saved catalogue search could not load. Retry; no complete search result is available.'});
  }
};
