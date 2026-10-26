/* Gacha Mark chain check: reads getAppraisalByCert(grader,certId) straight from the registry over public RPC
   and compares it with the record the page shows. No wallet, no library. */
const CC_RPC={46630:'https://46630.rpc.thirdweb.com',4663:'https://rpc.mainnet.chain.robinhood.com'};
const CC_SEL='0x609e275c';
function ccStr(s){const b=new TextEncoder().encode(String(s));let h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');const len=b.length.toString(16).padStart(64,'0');h=h.padEnd(Math.ceil(h.length/64)*64||0,'0');return len+h}
function ccEncode(grader,cert){const a=ccStr(grader),b=ccStr(cert);const off1=(64).toString(16).padStart(64,'0'),off2=(64+a.length/2).toString(16).padStart(64,'0');return CC_SEL+off1+off2+a+b}
function ccDecode(hex){const h=String(hex||'').replace(/^0x/,'');if(h.length<64*11)return null;const w=i=>BigInt('0x'+h.slice(i*64,i*64+64));
 return {low:Number(w(0)),point:Number(w(1)),high:Number(w(2)),ltvBps:Number(w(3)),confidenceScore:Number(w(4)),compCount:Number(w(5)),confidence:Number(w(6)),risk:Number(w(7)),eligible:w(8)!==0n,appraisedAt:Number(w(9)),attester:'0x'+h.slice(9*64+64+24,11*64)}}
function ccCompare(rec,ch){if(!ch||!ch.appraisedAt)return {k:'missing'};const cents=v=>Math.round(Number(v)*100);
 const diffs=[];[['low','Low'],['point','Value point'],['high','High']].forEach(([f,l])=>{if(cents(rec[f])!==ch[f])diffs.push(l)});
 const pt=rec.published?Math.floor(new Date(rec.published).getTime()/1000):null;
 if(pt!==null&&Math.abs(pt-ch.appraisedAt)>1)diffs.push('Publish time');
 return diffs.length?{k:'mismatch',diffs}:{k:'match'}}
async function ccRead(chainId,registry,grader,cert,fetchFn){const url=CC_RPC[chainId];if(!url||!/^0x[0-9a-fA-F]{40}$/.test(registry||''))return null;
 const r=await (fetchFn||fetch)(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:registry,data:ccEncode(grader,cert)},'latest']})});
 const j=await r.json();if(j.error){if(/revert/i.test(j.error.message||''))return {appraisedAt:0};throw new Error(j.error.message||'rpc')}return ccDecode(j.result)}
if(typeof module!=='undefined')module.exports={ccEncode,ccDecode,ccCompare,ccRead,CC_RPC};
