/* Clean Check (own-data phase): finds cert-claim conflicts across our own records.
   Input: a flat list of claims {source, grader, cert, owner, card, grade}. Sources today:
   marks, collection, mark_requests, plus partner listings where we have permission.
   Output kinds (flags to review, never a verdict on a slab):
   - multi_owner: one grader+cert claimed by more than one owner (on one chain, or without chain info)
   - moved_chain: one record per chain on 2+ chains; most likely bridged, listed apart from duplicates
   - identity_conflict: one grader+cert recorded with different card or grade
   - near_cert: two different certs that differ in 1-2 digits and name the same card
     (e.g. 12345678 vs 32345668). Could be a typo or a relabel; it needs a human look. */
const OWN=new Set(['marks','collection','mark_requests']);
function ccNorm(s){return String(s==null?'':s).trim()}
function ccCert(s){const d=ccNorm(s).replace(/[\s-]/g,'');return /^\d{5,12}$/.test(d)?d.replace(/^0+(?=\d)/,''):null}
function ccGrader(s){return ccNorm(s).toUpperCase()||'PSA'}
function ccCard(s){return ccNorm(s).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}
function ccGradeNum(s){const m=ccNorm(s).match(/\d+(\.\d)?/);return m?Number(m[0]):null}
function ccDigitDiff(a,b){if(a.length!==b.length)return Infinity;let n=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])n++;return n}
// Certs graded close together sit close numerically; a gap under 100,000 is normal, not a flag
function ccBatchSibling(a,b){return a.length===b.length&&Math.abs(Number(a)-Number(b))<100000}
function cleanCheck(claims,opts){
 const maxDiff=(opts&&opts.maxDiff)||2;const flags=[];const bad=[];const by=new Map();
 for(const c of claims||[]){const cert=ccCert(c.cert);if(!cert){bad.push(c);continue}
  const k=ccGrader(c.grader)+'/'+cert;if(!by.has(k))by.set(k,[]);by.get(k).push({...c,grader:ccGrader(c.grader),cert,key:k})}
 for(const [k,list] of by){
  const owners=[...new Set(list.map(x=>ccNorm(x.owner)).filter(Boolean))];
  // Our own Mark of a cert that is also listed on a partner marketplace is expected, not a conflict
  const outside=list.filter(x=>!OWN.has(x.source));const ownedByUs=list.length>outside.length;
  const ownOwners=new Set(list.filter(x=>OWN.has(x.source)).map(x=>ccNorm(x.owner)).filter(Boolean));
  if(ownedByUs&&outside.length>0&&ownOwners.size<=1&&new Set(outside.map(x=>ccNorm(x.owner)).filter(Boolean)).size<=1){}
  else if(owners.length>1){
   // One record per chain across 2+ chains = the slab was moved (bridged), not duplicated
   const onChain=list.filter(x=>ccNorm(x.chain));const per={};onChain.forEach(x=>per[x.chain]=(per[x.chain]||0)+1);
   const chains=Object.keys(per);
   if(onChain.length===list.length&&chains.length>1&&chains.every(c=>per[c]===1))flags.push({kind:'moved_chain',key:k,chains:chains.sort()});
   else flags.push({kind:'multi_owner',key:k,owners,sources:[...new Set(list.map(x=>x.source))]})}
  const cards=[...new Set(list.map(x=>ccCard(x.card)).filter(Boolean))];
  const grades=[...new Set(list.map(x=>ccGradeNum(x.grade)).filter(x=>x!==null))];
  if(cards.length>1||grades.length>1)flags.push({kind:'identity_conflict',key:k,cards,grades})}
 // near_cert: only compare certs of the same grader that name the same card (bucketed, so large sets stay fast)
 const buckets=new Map();
 for(const [k,list] of by)for(const card of new Set(list.map(x=>ccCard(x.card)).filter(Boolean))){const bk=list[0].grader+'|'+card;if(!buckets.has(bk))buckets.set(bk,[]);buckets.get(bk).push(k)}
 const seen=new Set();
 for(const [bk,ks] of buckets){if(ks.length<2)continue;for(let i=0;i<ks.length;i++)for(let j=i+1;j<ks.length;j++){
  const a=by.get(ks[i])[0].cert,b=by.get(ks[j])[0].cert;const d=ccDigitDiff(a,b);if(d<1||d>maxDiff||ccBatchSibling(a,b))continue;
  const pk=[ks[i],ks[j]].sort().join('~');if(seen.has(pk))continue;seen.add(pk);
  flags.push({kind:'near_cert',keys:[ks[i],ks[j]],digits:d,card:by.get(ks[j]).find(x=>ccCard(x.card)===bk.slice(bk.indexOf('|')+1)).card})}}
 return {checked:by.size,invalid:bad.length,flags}}
if(typeof module!=='undefined')module.exports={cleanCheck,ccCert,ccDigitDiff,ccBatchSibling};
