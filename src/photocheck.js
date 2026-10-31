/* Clean Check, photo phase: compares the codes printed on a slab (read from the listing photos)
   with the cert the listing claims. Flags to review, never a verdict on a slab.
   Input items: {key, id, grader, cert, codes:[{format, text, side}]}
   - key:   the listing's grader/cert key (e.g. "PSA/12345678")
   - id:    the token or listing id
   - codes: what a barcode/QR reader found in the photos (side = 'front' | 'back').
            Reading the image is done by the caller, so this file needs no image library.
   Output kinds per item:
   - match:            a PSA QR or label barcode shows the listed cert, nothing contradicts it
   - qr_psa_suffix:    the QR link ends in "/psa" (seen on copied labels in Oct 2026; genuine PSA QRs
                       point to psacard.com/cert/<cert>) - high
   - qr_mismatch:      a PSA QR link shows a different cert than the listing - high
   - barcode_mismatch: the label barcode shows a different cert than the listing - high
   - no_code:          no PSA QR or label barcode could be read (old labels have no QR; small photos) - unchecked
   Non-PSA QRs (e.g. Fanatics Collect vault stickers) are ignored, not flagged.
   pcShared then marks a cert seen in the photos of 2+ ids that are listed under DIFFERENT certs as
   slab_shared (one physical slab claimed by tokens for another cert) - high. The same cert listed twice
   with the same slab photo is left to the chain phase (usually a move between chains). */
const PC_PSA_HOST=/^(?:https?:\/\/)?(?:www\.)?psacard\.com\//i;
function pcDigits(s){return String(s||'').replace(/\D/g,'').replace(/^0+/,'')}
function pcParseQr(text){
 const t=String(text||'').trim();
 if(!PC_PSA_HOST.test(t))return {psa:false,text:t};
 const path=t.replace(PC_PSA_HOST,'/').split(/[?#]/)[0].replace(/\/+$/,'');
 const m=path.match(/\/cert\/(\d+)/i);
 return {psa:true,cert:m?pcDigits(m[1]):null,suffix:/\/psa$/i.test(path),text:t}}
function pcIsBarcode(f){return /itf|code ?128|code ?39|interleaved/i.test(String(f||''))}
function pcCheck(item){
 const want=pcDigits(item.cert),codes=item.codes||[],seen=new Set(),notes=[];
 let kind=null,level='ok',matched=false,ignored=0;
 for(const c of codes){
  if(/qr/i.test(String(c.format||''))){
   const q=pcParseQr(c.text);
   if(!q.psa){ignored++;continue}
   if(q.cert)seen.add(q.cert);
   if(q.suffix){kind='qr_psa_suffix';level='high';notes.push('QR ends in /psa: '+q.text)}
   else if(q.cert&&q.cert!==want){kind=kind||'qr_mismatch';level='high';notes.push('QR cert '+q.cert)}
   else if(q.cert===want)matched=true}
  else if(pcIsBarcode(c.format)){
   const b=pcDigits(c.text);if(!b)continue;seen.add(b);
   if(b!==want){kind=kind||'barcode_mismatch';level='high';notes.push('barcode cert '+b)}
   else matched=true}}
 if(!kind){if(matched)kind='match';else {kind='no_code';level='unchecked'}}
 return {key:item.key,id:item.id,cert:want,kind,level,seen:[...seen],ignored,notes}}
function pcShared(results){
 const by=new Map(),certOf=new Map(results.map(r=>[r.id,r.cert]));
 for(const r of results)for(const c of r.seen||[]){if(!by.has(c))by.set(c,new Set());by.get(c).add(r.id)}
 const shared=new Map();
 for(const [c,ids] of by)if(ids.size>1&&new Set([...ids].map(i=>certOf.get(i))).size>1)shared.set(c,[...ids]);
 return results.map(r=>{const hit=(r.seen||[]).filter(c=>shared.has(c));
  if(!hit.length)return r;
  return {...r,kind:'slab_shared',level:'high',sharedWith:[...new Set(hit.flatMap(c=>shared.get(c)))].filter(i=>i!==r.id),
   notes:[...r.notes,...hit.map(c=>'cert '+c+' seen in photos of '+shared.get(c).length+' ids')]}})}
function pcRun(items){
 const results=pcShared(items.map(pcCheck));
 const summary={};for(const r of results)summary[r.kind]=(summary[r.kind]||0)+1;
 return {results,summary}}
if(typeof module!=='undefined')module.exports={pcParseQr,pcCheck,pcShared,pcRun};
