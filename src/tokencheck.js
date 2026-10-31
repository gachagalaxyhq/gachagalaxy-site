/* Clean Check, chain phase: looks up each flagged cert's tokens on chain and sorts them.
   Input tokens: {key, ref, record} where ref is either a Solana address or "<chain>-<0xcontract>-<tokenId>"
   (e.g. "base-0xabc...-12"). Known addresses are passed in, never hard-coded here:
   - lockups: addresses that hold old copies after a move between chains (a parked copy is not a live claim)
   - packs:   addresses that hold cards waiting to be pulled from packs
   Output kinds per cert (flags to review, never a verdict on a slab):
   - clean_move:         one live copy, any others parked in a lock-up or gone
   - pack_pool_double:   2+ live copies and one sits in a pack address (someone could pull a card another person owns) - high
   - double_record:      2+ live copies in different hands - high
   - same_holder_double: 2+ live copies, one holder - low
   - all_gone:           no copy found on chain
   Lookups go through an rpc(chain, method, params|batch) function supplied by the caller, so the
   provider and key stay outside this file. Calls are spaced by opts.gapMs to stay under rate limits. */
const SPL='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',CORE='CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function chB58(bytes){let n=0n;for(const b of bytes)n=n*256n+BigInt(b);let s='';while(n>0n){s=B58[Number(n%58n)]+s;n/=58n}
 for(const b of bytes){if(b!==0)break;s='1'+s}return s}
function chB64(s){if(typeof Buffer!=='undefined')return Uint8Array.from(Buffer.from(s,'base64'));const t=atob(s);return Uint8Array.from(t,c=>c.charCodeAt(0))}
function chParseRef(ref){const r=String(ref||'').trim();const m=r.match(/^([a-z0-9]+)-(0x[0-9a-fA-F]{40})-(\d+)$/);
 if(m)return {chain:m[1],contract:m[2].toLowerCase(),tokenId:m[3]};
 if(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r))return {chain:'solana',address:r};return null}
const chSleep=ms=>new Promise(r=>setTimeout(r,ms));
function chunk(a,n){const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o}
async function chLookup(tokens,rpc,opts){
 const gap=(opts&&opts.gapMs)!=null?opts.gapMs:1200;const out=[];const sol=[],evm={};
 for(const t of tokens){const p=chParseRef(t.ref);if(!p){out.push({...t,chain:null,exists:null,holder:null,error:'bad_ref'});continue}
  if(p.chain==='solana')sol.push({...t,...p});else (evm[p.chain]=evm[p.chain]||[]).push({...t,...p})}
 for(const part of chunk(sol,100)){
  const res=await rpc('solana','getMultipleAccounts',[part.map(x=>x.address),{encoding:'base64'}]);await chSleep(gap);
  const vals=(res&&res.value)||[];
  for(let i=0;i<part.length;i++){const t=part[i],v=vals[i];const base={key:t.key,ref:t.ref,record:t.record,chain:'solana'};
   if(!v){out.push({...base,exists:false,holder:null});continue}
   if(v.owner===CORE){const d=chB64(v.data[0]);out.push({...base,exists:true,standard:'core',holder:d.length>=33&&d[0]===1?chB58(d.slice(1,33)):null});continue}
   if(v.owner===SPL){const la=await rpc('solana','getTokenLargestAccounts',[t.address]);await chSleep(gap);
    const acct=((la&&la.value)||[]).find(a=>a.amount==='1');let holder=null;
    if(acct){const ai=await rpc('solana','getAccountInfo',[acct.address,{encoding:'jsonParsed'}]);await chSleep(gap);
     holder=ai&&ai.value&&ai.value.data&&ai.value.data.parsed?ai.value.data.parsed.info.owner:null}
    out.push({...base,exists:!!acct,standard:'spl',holder});continue}
   out.push({...base,exists:true,standard:'other',holder:null})}}
 for(const [chain,list] of Object.entries(evm))for(const part of chunk(list,25)){
  const batch=part.map((t,j)=>({jsonrpc:'2.0',id:j,method:'eth_call',params:[{to:t.contract,data:'0x6352211e'+BigInt(t.tokenId).toString(16).padStart(64,'0')},'latest']}));
  const res=await rpc(chain,null,batch);await chSleep(gap);const by={};for(const r of res||[])by[r.id]=r;
  part.forEach((t,j)=>{const r=by[j]||{};const ok=typeof r.result==='string'&&r.result.length>=66;
   out.push({key:t.key,ref:t.ref,record:t.record,chain,exists:ok,holder:ok?'0x'+r.result.slice(-40).toLowerCase():null,error:ok||r.error?undefined:'no_reply'})})}
 return out}
function chClassify(state,opts){
 const low=a=>String(a||'').toLowerCase();
 const lockups=new Set(((opts&&opts.lockups)||[]).map(low)),packs=new Set(((opts&&opts.packs)||[]).map(low));
 const by=new Map();for(const s of state){if(!by.has(s.key))by.set(s.key,[]);by.get(s.key).push(s)}
 const results=[];
 for(const [key,list] of by){
  const live=list.filter(s=>s.exists&&!lockups.has(low(s.holder)));
  const parked=list.filter(s=>s.exists&&lockups.has(low(s.holder))).length,gone=list.filter(s=>s.exists===false).length;
  let kind,level;
  if(!list.some(s=>s.exists)){kind='all_gone';level='review'}
  else if(live.length<=1){kind='clean_move';level='ok'}
  else if(live.some(s=>packs.has(low(s.holder)))){kind='pack_pool_double';level='high'}
  else if(new Set(live.map(s=>low(s.holder))).size===1&&live[0].holder){kind='same_holder_double';level='low'}
  else {kind='double_record';level='high'}
  results.push({key,kind,level,live:live.map(s=>({chain:s.chain,holder:s.holder,record:s.record})),parked,gone})}
 const summary={};for(const r of results)summary[r.kind]=(summary[r.kind]||0)+1;
 return {results,summary}}
if(typeof module!=='undefined')module.exports={chParseRef,chLookup,chClassify,chB58};
