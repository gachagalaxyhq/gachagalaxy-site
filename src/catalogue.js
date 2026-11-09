/* Broader listing browse is deliberately separate from pricing groups and Marks. */
const CAT={manifest:null,worker:null,seq:0,cache:new Map(),pending:new Map()};
async function catalogueJSON(url){
 const r=await fetch(url,{signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw new Error('Saved catalogue unavailable');
 return r.json();
}
async function catalogueManifest(){
 if(CAT.manifest)return CAT.manifest;
 const m=await catalogueJSON('/data/catalogue/manifest.json');
 if(m.schema_version!==1||!Number.isSafeInteger(m.total_records)||m.total_records<1||!Array.isArray(m.shards)||!Array.isArray(m.search_shards)||!/^\/data\/catalogue\/snapshot-[a-f0-9]{20}\/$/.test(m.base_url)||m.shards.reduce((n,s)=>n+s.count,0)!==m.total_records)throw new Error('Invalid saved catalogue manifest');
  for(const s of [...m.shards,...m.search_shards])if(!/^(listings|search)-\d{4}\.json$/.test(s.file)||!Number.isSafeInteger(s.count)||s.count<1)throw new Error('Invalid saved catalogue shard');
 if(m.browse_first_shard_order&&(!Array.isArray(m.browse_first_shard_order)||m.browse_first_shard_order.length!==m.shards[0].count||new Set(m.browse_first_shard_order).size!==m.shards[0].count||m.browse_first_shard_order.some(n=>!Number.isSafeInteger(n)||n<0||n>=m.shards[0].count)))throw new Error('Invalid opening-page order');
  const decoded=await catalogueJSON('/data/catalogue/decoded.json');
  if(decoded.version!==m.version||decoded.total_records!==m.total_records||decoded.decoded_records!==decoded.refs?.length||!Number.isSafeInteger(decoded.decoded_records)||new Set(decoded.refs.map(JSON.stringify)).size!==decoded.refs.length||decoded.refs.some(r=>!Array.isArray(r)||r.length!==2||!r.every(Number.isSafeInteger)||r[0]<0||!m.shards[r[0]]||r[1]<0||r[1]>=m.shards[r[0]].count))throw new Error('Invalid decoded catalogue selection');
  m.decoded=decoded;CAT.manifest=m;return m;
}
async function catalogueShard(m,n){
 if(!Number.isSafeInteger(n)||!m.shards[n])throw new Error('Missing saved shard');
 if(CAT.cache.has(n)){const r=CAT.cache.get(n);CAT.cache.delete(n);CAT.cache.set(n,r);return r}
 if(CAT.pending.has(n))return CAT.pending.get(n);
 const pending=catalogueJSON(m.base_url+m.shards[n].file).then(rows=>{
  if(!Array.isArray(rows)||rows.length!==m.shards[n].count||rows.some(r=>!r||typeof r.id!=='string'||!r.scan))throw new Error('Invalid saved listing data');
  CAT.cache.set(n,rows);while(CAT.cache.size>6)CAT.cache.delete(CAT.cache.keys().next().value);return rows;
 }).finally(()=>CAT.pending.delete(n));CAT.pending.set(n,pending);return pending;
}
function catalogueSearch(m,params,id){
 if(!CAT.worker){
  CAT.worker=new Worker('/data/catalogue-search.js');
  CAT.worker.onmessage=({data})=>{
   if(data.type==='progress'){const el=$('#catalogue-progress');if(el)el.textContent=`Loading searchable saved records: ${data.loaded.toLocaleString()} / ${data.total.toLocaleString()}…`;return}
   const p=CAT.requests?.get(data.id);if(!p)return;CAT.requests.delete(data.id);clearTimeout(p.timer);
   data.type==='results'?p.resolve(data):p.reject(new Error(data.message));
  };
  CAT.worker.onerror=()=>{for(const p of CAT.requests?.values()||[]){clearTimeout(p.timer);p.reject(new Error('Search worker unavailable'))}CAT.requests?.clear();CAT.worker.terminate();CAT.worker=null};
 }
 CAT.requests??=new Map();
 // Superseded route searches are settled, not left as hanging promises.
 for(const [old,p] of CAT.requests){clearTimeout(p.timer);p.reject(new Error('superseded'));CAT.requests.delete(old)}
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{CAT.requests.delete(id);reject(new Error('Search timed out'));CAT.worker?.terminate();CAT.worker=null},120000);
  CAT.requests.set(id,{resolve,reject,timer});CAT.worker.postMessage({...params,id,manifest:m});
 });
}
const catalogueCount=n=>Number(n).toLocaleString('en-US');
const catalogueDecoded=row=>row?.scan?.processed===true&&row.scan.status==='decoded';
async function cataloguePreviewRows(m){
 const refs=m.decoded.refs.slice(0,8),shards=new Map(await Promise.all([...new Set(refs.map(r=>r[0]))].map(async n=>[n,await catalogueShard(m,n)])));
 return refs.map(ref=>catalogueRow(shards.get(ref[0])[ref[1]],ref)).join('');
}
async function markCataloguePreview(){
 const current=location.hash,target=document.createElement('section');target.className='sec';target.id='mark-catalogue-preview';target.setAttribute('aria-labelledby','mark-catalogue-title');
 const heading='<h2 id="mark-catalogue-title">Browse more cards</h2><p>Explore catalogue listings, separate from the Gacha Mark records above.</p><p><a class="btn btn-g" href="#/cards">Browse all cards →</a></p>';
  target.innerHTML=heading+'<p role="status">Loading cards…</p>';V.appendChild(target);
 try{
   const m=await catalogueManifest(),html=await cataloguePreviewRows(m);if(location.hash!==current||!target.isConnected)return;
   target.innerHTML=heading+`<div class="list catalogue-grid">${html}</div>`;
 }catch(e){if(location.hash===current&&target.isConnected)target.innerHTML=heading+'<p role="status">Cards could not load. <a href="#/cards">Open the catalogue to retry →</a></p>'}
}
async function sectionSavedPreview(kind){
  if(kind==='collection')return;
 const current=location.hash,target=document.createElement('section');target.className='sec';target.id='section-saved-preview';
 target.innerHTML='<h2>Browse cards</h2><p role="status">Loading public catalogue examples…</p>';V.appendChild(target);
  try{const m=await catalogueManifest(),html=await cataloguePreviewRows(m);if(location.hash!==current||!target.isConnected)return;
  target.innerHTML=`<h2>Public cards</h2><p>Catalogue examples, not your ${kind==='watchlist'?'watchlist':'collection'}.</p><p class="account-example-links"><a href="#/cards">Browse catalogue →</a><a href="#/groups">Price comparisons →</a></p><div class="list catalogue-grid">${html}</div>`;
 }catch(e){if(location.hash===current&&target.isConnected)target.innerHTML='<h2>Public catalogue unavailable</h2><p>Your account records are not affected. <a href="#/cards">Retry catalogue →</a></p>'}
}
async function publicDataSection(){
 setTab('api');const current=location.hash;V.innerHTML='<h1 class="pg">Public data</h1><p role="status">Loading published catalogue metadata…</p>';
 try{const m=await catalogueManifest();if(location.hash!==current)return;
 V.innerHTML=`<h1 class="pg">Public data</h1>${catalogueProvenance(m)}<div class="apis"><article class="panel apc"><h2>Catalogue index</h2><p>Read-only JSON files for the published catalogue. No sign-in is required.</p><a class="btn btn-p" href="/data/catalogue/manifest.json" target="_blank" rel="noopener">Open manifest →</a></article><article class="panel apc"><h2>Listing data</h2><p>Public listing fields and recorded scan results. Null indicates missing or withheld information. Use the base_url and file names in the manifest to retrieve each data file.</p><a class="btn btn-g" href="${esc(m.base_url+m.shards[0].file)}" target="_blank" rel="noopener">Open listing data →</a></article><article class="panel apc"><h2>Price comparisons</h2><p>${D.cards.length} selected price-comparison groups, not all catalogue listings. Saved asking-price inputs, not completed sales. These files are snapshots, not a live pricing service.</p><a class="btn btn-g" href="/prices.json" target="_blank" rel="noopener">Open pricing JSON →</a> <a href="#/groups">Browse price groups →</a></article></div><details class="sec panel apc"><summary>Example record</summary><p>An entry from the published catalogue.</p><pre id="api-sample" style="white-space:pre-wrap;overflow-wrap:anywhere">Loading example…</pre></details>`;
  const ref=m.decoded.refs[0],rows=ref?await catalogueShard(m,ref[0]):[];if(location.hash===current&&$('#api-sample'))$('#api-sample').textContent=JSON.stringify(rows[ref?.[1]]||null,null,2);
 }catch(e){if(location.hash===current)V.innerHTML='<h1 class="pg">Public data</h1><div class="panel empty" role="alert">Public data unavailable. Try again later. <a href="#/cards">Retry catalogue →</a></div>'}
}
function catalogueProvenance(m){return `<p class="pg-sub">Saved listings · snapshot ${esc(m.capture_range[0].slice(0,10))}.</p><details class="catalogue-source"><summary>Sources and limits</summary><p>Source: Collector Crypt · ${catalogueCount(m.decoded.decoded_records)} decoded listings from ${catalogueCount(m.total_records)} saved listing records, including unpriced listings. Captured ${esc(m.capture_range[0])} to ${esc(m.capture_range[1])}. Scan checkpoint ${esc(m.scan_checkpoint||m.scan_range[1])}. Exported ${esc(m.exported_at)}.</p><p>Browse and search include only saved scans with processed=true and status=decoded; processing alone is not decoding. All raw saved records remain in the provenance shards. Listings, scan evidence and issued Marks are distinct records. Authenticity, ownership, custody, issuance and current availability are not verified by this catalogue. Asking prices are not completed sales or valuations. The opening page spans distinct source sets, not a price ranking.</p></details>`}
function catalogueLink(ref,row){return '#/catalogue/'+ref[0]+'/'+ref[1]+'/'+encodeURIComponent(row.id)}
function catalogueRow(row,ref){
  if(!catalogueDecoded(row))throw new Error('Non-decoded listing excluded');
 const ask=row.ask===null?'Ask not supplied':`${esc(row.currency||'Currency not supplied')} ${esc(Number(row.ask).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}))} · saved ask`;
 return `<a class="panel rowc catalogue-row" href="${catalogueLink(ref,row)}">${row.image?`<img loading="lazy" referrerpolicy="no-referrer" src="${esc(row.image)}" alt="${esc(row.name||'Saved listing')}">`:'<div class="ph-img image-unavailable" role="img" aria-label="Image unavailable">Image unavailable</div>'}<div><h3>${esc(detailName(row))}</h3><div class="st">${esc(row.set||'Set not supplied')} · ${esc(row.number||'Number not supplied')}</div><div class="sm">${esc(row.grader||'Grader not supplied')} · ${esc(row.grade||'Grade not supplied')} · cert ${esc(row.cert||'not supplied')}</div></div><div class="cell catalogue-ask"><span>Asking price</span><b>${ask}</b></div></a>`;
}
function catalogueParams(){
 const p=new URLSearchParams((location.hash.split('?')[1]||''));
 const page=Math.max(0,Number(p.get('page'))||0);
  return {query:(p.get('q')||'').slice(0,200),grader:p.get('grader')||'',page:Number.isSafeInteger(page)?page:0};
}
function catalogueNavigate(params){const p=new URLSearchParams();for(const [k,v] of Object.entries({q:params.query,grader:params.grader,scan:params.scan,page:params.page}))if(v)p.set(k,v);const hash='#/cards'+(p.size?'?'+p:'');if(location.hash===hash)catalogueBrowse();else location.hash=hash}
async function catalogueBrowse(){
 const seq=++CAT.seq,current=location.hash,params=catalogueParams();setTab('cards');$('#q').value=params.query;
 V.innerHTML='<h1 class="pg">Catalogue</h1><p role="status">Loading saved listings…</p>';
 const here=()=>seq===CAT.seq&&location.hash===current;
 try{
  const m=await catalogueManifest();if(!here())return;
  const option=(v,label,selected)=>`<option value="${esc(v)}"${selected===v?' selected':''}>${esc(label)}</option>`;
   V.innerHTML=`<div class="catalogue-heading"><div class="catalogue-title"><h1 class="pg">Browse cards</h1><p id="catalogue-progress" role="status" aria-live="polite">Loading listings…</p></div><nav class="catalogue-links" aria-label="Related records"><a href="#/groups">Price comparisons</a><a href="#/certified">Gacha Marks</a></nav></div><p class="pg-sub">Research graded trading cards in one place. Browse photos, grades and asking prices, then open a card for its listing and certificate details. Use <a href="/check">Price Check</a> for past sales or <a href="/cleancheck">Clean Check</a> for certificate evidence.</p><form id="catalogue-form" class="bar" role="search"><label class="qbox"><input id="catalogue-query" aria-label="Search cards" maxlength="200" placeholder="Search by card name, set, number or certificate" value="${esc(params.query)}"></label><select id="catalogue-grader" aria-label="Saved catalogue grader">${option('','All graders',params.grader)}${Object.entries(m.decoded.graders).filter(([g])=>g!=='Not supplied').map(([g,n])=>option(g,`${g} (${catalogueCount(n)})`,params.grader)).join('')}</select><button class="btn btn-p" type="submit">Search</button></form><div id="catalogue-results" aria-busy="true"></div>`;
   const submit=()=>catalogueNavigate({query:$('#catalogue-query').value,grader:$('#catalogue-grader').value,page:0});
   $('#catalogue-form').onsubmit=e=>{e.preventDefault();submit()};$('#catalogue-grader').onchange=submit;
  let result;
   if(params.query||params.grader){result=await catalogueSearch(m,{...params,pageSize:m.page_size},seq)}
   else{const start=params.page*m.page_size;result={total:m.decoded.decoded_records,refs:m.decoded.refs.slice(start,start+m.page_size)}}
  if(!here())return;
  const needed=[...new Set(result.refs.map(r=>r[0]))];const shards=new Map(await Promise.all(needed.map(async n=>[n,await catalogueShard(m,n)])));
  if(!here())return;
  const rows=result.refs.map(ref=>{const row=shards.get(ref[0])[ref[1]];if(!row)throw new Error('Missing saved result');return catalogueRow(row,ref)});
  const pages=Math.ceil(result.total/m.page_size),start=params.page*m.page_size;
   $('#catalogue-progress').textContent=`${catalogueCount(result.total)} listings${rows.length?` · ${catalogueCount(start+1)}–${catalogueCount(start+rows.length)}`:''}`;
  $('#catalogue-results').setAttribute('aria-busy','false');
   $('#catalogue-results').innerHTML=`${rows.length?`<div class="list catalogue-grid">${rows.join('')}</div>`:`<div class="panel empty">${result.total?'Page outside the saved results. Return to the first page.':'No saved listings match. Try fewer words or clear the filters.'}</div>`}<div class="bar catalogue-pagination"><button id="catalogue-prev" class="btn btn-g" ${params.page===0?'disabled':''}>Previous page</button><span>Page ${params.page+1} of ${Math.max(1,pages)}</span><button id="catalogue-next" class="btn btn-g" ${params.page+1>=pages?'disabled':''}>Next page</button><button id="catalogue-reset" class="btn btn-g">Clear search</button></div>`;
  $('#catalogue-prev').onclick=()=>catalogueNavigate({...params,page:Math.max(0,params.page-1)});$('#catalogue-next').onclick=()=>catalogueNavigate({...params,page:params.page+1});$('#catalogue-reset').onclick=()=>catalogueNavigate({});
 }catch(error){if(!here())return;V.innerHTML='<h1 class="pg">Catalogue</h1><div class="panel empty" role="alert">Saved listings could not load. Results are unavailable. <button class="btn btn-g" id="catalogue-retry">Retry</button> <a href="#/groups">Price comparisons</a></div>';$('#catalogue-retry').onclick=()=>catalogueBrowse()}
}
function detailDate(value){
 if(!value)return '—';const date=new Date(value);if(!Number.isFinite(date.getTime()))return '—';
 const day=date.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
 return /^\d{4}-\d{2}-\d{2}$/.test(String(value))?day:day+', '+date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'})+' UTC';
}
function detailAmount(value,currency){
 if(value==null||!Number.isFinite(Number(value)))return '—';
 const number=Number(value),precision=Math.min(8,Math.max(2,(String(number).split('.')[1]||'').length));
 return (currency?String(currency)+' ':'')+number.toLocaleString('en-US',{minimumFractionDigits:precision,maximumFractionDigits:8});
}
function detailName(row){
 const raw=String(row.name||'').trim();if(!raw)return 'Card name unavailable';
 const prefix=/^\d{4}\s+#(\S+)\s+/.exec(raw);
 if(!prefix||prefix[1]!==String(row.number||''))return raw;
 const grader=['PSA','CGC','BGS','SGC'].includes(row.grader)?row.grader:null;
 if(!grader)return raw;
 const rest=raw.slice(prefix[0].length),boundary=new RegExp('\\s+'+grader+'\\s+\\d+(?:\\.\\d+)?(?:\\s|$)').exec(rest);
 return boundary&&boundary.index>0?rest.slice(0,boundary.index).trim():raw;
}
function detailImage(row){
 const id=String(row.id||'').replace(/^source_id:/,'');
 const match=D.cards.find(card=>card.decoded===true&&/^\/cards\/[A-Za-z0-9_-]+\.webp$/.test(card.im||'')&&card.L?.some(listing=>listing[6]===true&&listing[7]===id&&listing[1]?.split(' ')[0]===row.grader&&(!listing[5]||listing[5]===row.cert)));
 return match?.im||row.image;
}
async function catalogueDetail(shard,offset,id){
 const seq=++CAT.seq,current=location.hash;setTab('cards');V.innerHTML='<p role="status">Loading saved listing record…</p>';
 const here=()=>seq===CAT.seq&&location.hash===current;
 try{
  const m=await catalogueManifest(),rows=await catalogueShard(m,Number(shard)),r=rows[Number(offset)];
  if(!here())return;
  if(!Number.isSafeInteger(Number(offset))||Number(offset)<0||!r||r.id!==decodeURIComponent(id||''))throw new Error('Saved listing not in this snapshot');
  const scan=r.scan,mark=D.certs.find(c=>(c.grader||'PSA')===r.grader&&c.cert===r.cert);
  const pair=['PSA','CGC'].includes(r.grader)&&/^\d{6,10}$/.test(r.cert||'');
   V.innerHTML=`<div class="crumb"><a href="#/cards">← Catalogue</a></div><article class="panel apc listing-detail"><span class="eyebrow">Listing</span><h1 class="pg">${esc(detailName(r))}</h1><div class="chead">${detailImage(r)?`<img class="cimg" referrerpolicy="no-referrer" src="${esc(detailImage(r))}" alt="${esc(detailName(r))} listing photo">`:'<p class="prev-note">Listing photo unavailable.</p>'}<div><dl class="detail-fields"><dt>Set</dt><dd>${esc(r.set||'—')}</dd><dt>Card number</dt><dd>${esc(r.number||'—')}</dd><dt>Grader</dt><dd>${esc(r.grader||'—')}</dd><dt>Grade</dt><dd>${esc(r.grade||'—')}</dd><dt>Cert reference</dt><dd class="num">${esc(r.cert||'—')}</dd></dl><div class="detail-price"><span>Asking price</span><b class="num">${esc(detailAmount(r.ask,r.currency))}</b><small>Saved asking price · availability not checked</small></div>${mark?`<p class="detail-mark"><a href="#/cert/${encodeURIComponent(mark.cert)}">View Gacha Mark →</a></p>`:''}<div class="bar">${pair?`<a class="btn btn-g" href="/platform?saved=1#/passport/${r.grader}/${encodeURIComponent(r.cert)}">Share card record →</a><a class="btn btn-p" href="/cleancheck?cert=${encodeURIComponent(r.cert)}&amp;grader=${r.grader}">Check certificate →</a>`:''}</div></div></div><details class="pricing-source detail-source"><summary>Source details</summary><dl class="detail-fields"><dt>Source</dt><dd>Collector Crypt</dd><dt>Listing ID</dt><dd class="num">${esc(r.id)}</dd><dt>Original title</dt><dd>${esc(r.name||'—')}</dd><dt>Original image URL</dt><dd>${esc(r.image||'—')}</dd><dt>Listed</dt><dd>${esc(detailDate(r.listed_at))}</dd><dt>Captured</dt><dd>${esc(detailDate(r.captured_at))}</dd><dt>Scan recorded</dt><dd>${esc(detailDate(scan.checked_at))}</dd></dl><p>Asking prices are not completed sales or valuations. Physical authenticity, ownership and custody have not been checked. Opening this saved listing does not issue anything. Evidence coverage may differ between services.</p><details class="pricing-source"><summary>Scan evidence</summary><p>${scan.processed?'A back-image scan result was recorded.':'No processed back-image scan is available.'}</p><p>Scan result: ${esc(String(scan.status||'not checked').replaceAll('_',' '))} · QR comparison: ${esc(String(scan.qr_status||'not checked').replaceAll('_',' '))} · cert comparison: ${esc(String(scan.cert_comparison||'not checked').replaceAll('_',' '))}.</p><p>A decoded payload or cert-string match is not physical authentication, a live grader lookup or an issued Mark. Non-PSA formats remain review-only. QR destinations are not published or followed.</p></details>${catalogueProvenance(m)}</details></article>`;
 }catch(error){if(here())V.innerHTML='<div class="panel empty" role="alert">This saved listing could not load or its snapshot has changed. No substitute record is shown. <a href="#/cards">Search the current saved catalogue →</a></div>'}
}
