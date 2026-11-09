/* Card Passport presentation model. Saved inputs only; no network, issuance or valuation.
   Separate from the existing internal Price Passport calculation engine. */
function cardPassport(grader, cert, rows, marks, images = {}) {
  if (!['PSA', 'CGC'].includes(grader) || !/^\d{6,13}$/.test(cert || '')) return { status: 'invalid' };
  if (!Array.isArray(rows) || !Array.isArray(marks) || rows.some(r => !r || typeof r !== 'object')) return { status: 'unavailable' };
  const listings = rows.filter(r => r.cert === cert && String(r.grader || '').trim().toUpperCase() === grader);
  const mark = marks.find(m => m.cert === cert && String(m.grader || 'PSA').toUpperCase() === grader) || null;
  if (!listings.length && !mark) return { status: 'missing', grader, cert };
  const photo = images[grader + '|' + cert];
  const matchingPhoto = photo && listings.some(row => row.name === photo.name && row.grade === photo.grade) ? photo : null;
  return {
    status: 'saved', grader, cert, listings, mark,
    listingSources: listings.map(row => ({ row, url: passportSourceUrl(row.listing_url) || passportSourceUrl(row.source_url) || passportSourceUrl(row.url) })),
    title: mark ? mark.name + (mark.num ? ' ' + mark.num : '') : listings[0].name || 'Saved card',
    image: mark && mark.img || matchingPhoto && matchingPhoto.image || null,
    number: matchingPhoto && matchingPhoto.number || null,
    identitySource: mark ? 'Bundled saved Mark record' : 'Saved Collector Crypt index',
    evidenceStatus: 'saved / indexed',
    graderRecord: 'not_checked', qrMatch: 'not_checked', physicalAuthenticity: 'not_checked',
    cleanCheckStatus: 'not_run_here', horizenExecution: 'not_checked'
  };
}
// Only explicit source URLs, never inferred from certificate or marketplace IDs.
function passportSourceUrl(value) {
  if (typeof value !== 'string' || value !== value.trim() || /[\s\\\u0000-\u001f\u007f]/.test(value) || !/^https:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !host.includes('.') || host.endsWith('.') || host.includes(':') || /^\d+(\.\d+)*$/.test(host) || /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}
if(typeof module!=='undefined')module.exports={cardPassport,passportSourceUrl};
