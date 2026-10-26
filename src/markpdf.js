/* Gacha Mark PDF certificate. Pure builder: buildMarkPdf(jsPDF, cert, assets, now) -> jsPDF doc.
   cert   = the same object the certificate page renders (toCert shape).
   assets = {slab: dataURL|null, qr: dataURL|null, seal: dataURL|null} - rasterised by the page.
   Standard PDF fonts only cover Latin-1, so text is passed through ascii() first.
   States the price basis as recorded (asking prices today) - never claims sold prices. */
function markPdfAscii(s){return String(s==null?'':s).replace(/[\u2013\u2014]/g,'-').replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/\u00b7/g,'|').replace(/\u2026/g,'...').normalize('NFKD').replace(/[^\x20-\x7e]/g,'')}
function markPdfStatus(c,now,validDays){const E=c.ev||[];if(c.revoked)return {k:'revoked',label:'REVOKED',last:E[0]?E[0].t:null,until:null};if(!E.length)return {k:'none',label:'NO ONCHAIN RECORD',last:null,until:null};
 const last=E[0].t,until=Date.parse(last)+validDays*864e5;return now<until?{k:'active',label:'ACTIVE',last,until}:{k:'expired',label:'EXPIRED',last,until}}
function buildMarkPdf(jsPDF,c,assets,now,opt){
 opt=opt||{};const VD=opt.validDays||30,A=markPdfAscii,base=opt.base||'https://gachagalaxy.io/platform#/cert/';
 const doc=new jsPDF({unit:'mm',format:'a4',compress:true});const W=210,H=297,M=16;
 const ink=[26,18,40],dim=[110,104,124],line=[226,222,234],pur=[122,34,201],grn=[22,128,84],amb=[180,83,9];
 const st=markPdfStatus(c,now,VD);const test=c.network==='robinhood-testnet'||c.kind==='example';
 const money=v=>v==null||isNaN(v)?'-':'$'+Number(v).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0});
 const d=t=>t?new Date(t).toISOString().slice(0,10):'-';
 const tier=s=>s>=70?'High':s>=40?'Medium':'Low';
 doc.setProperties({title:A(`Gacha Mark - ${c.grader||'PSA'} ${c.cert}`),subject:'Gacha Mark certificate',author:'Gacha Galaxy',creator:'gachagalaxy.io'});
 // header band
 doc.setFillColor(...pur);doc.rect(0,0,W,3,'F');
 if(assets.seal)try{doc.addImage(assets.seal,'PNG',M,10,14,14)}catch(e){}
 doc.setFont('helvetica','bold');doc.setFontSize(16);doc.setTextColor(...ink);doc.text('Gacha Mark',M+(assets.seal?18:0),17);
 doc.setFont('helvetica','normal');doc.setFontSize(9);doc.setTextColor(...dim);doc.text('Certificate record | gachagalaxy.io',M+(assets.seal?18:0),22);
 const sc=st.k==='active'?grn:st.k==='revoked'?amb:dim;doc.setDrawColor(...sc);doc.setTextColor(...sc);doc.setFont('helvetica','bold');doc.setFontSize(9);
 const sw=doc.getTextWidth(st.label)+8;doc.roundedRect(W-M-sw,11,sw,8,2,2,'S');doc.text(st.label,W-M-sw/2,16.3,{align:'center'});
 doc.setDrawColor(...line);doc.line(M,30,W-M,30);
 // slab + identity
 let y=38;const iw=58,ih=96;
 if(assets.slab){try{doc.addImage(assets.slab,'JPEG',M,y,iw,ih,undefined,'FAST')}catch(e){doc.setDrawColor(...line);doc.rect(M,y,iw,ih)}}else{doc.setDrawColor(...line);doc.rect(M,y,iw,ih)}
 const x=M+iw+10,tw=W-M-x;
 doc.setTextColor(...ink);doc.setFont('helvetica','bold');doc.setFontSize(20);
 const title=doc.splitTextToSize(A(`${c.name} ${c.num||''}`.trim()),tw);doc.text(title,x,y+6);let ty=y+6+title.length*8;
 doc.setFont('helvetica','normal');doc.setFontSize(10.5);doc.setTextColor(...dim);
 const sub=doc.splitTextToSize(A([c.set,c.year,c.grade+(c.gradeLabel?` (${c.gradeLabel})`:'')].filter(Boolean).join(' | ')),tw);doc.text(sub,x,ty);ty+=sub.length*5+1;
 doc.text(A(`${c.grader||'PSA'} cert ${c.cert}`),x,ty);ty+=10;
 doc.setFontSize(8);doc.setFont('helvetica','bold');doc.text('VALUE POINT',x,ty);ty+=9;
 doc.setTextColor(...ink);doc.setFontSize(30);doc.text(money(c.point),x,ty);ty+=8;
 // band
 const bw=tw,lo=c.low,hi=c.high,pt=c.point;doc.setFillColor(...line);doc.roundedRect(x,ty,bw,2.4,1.2,1.2,'F');
 const p=hi>lo?.15+.7*((pt-lo)/(hi-lo)):.5;doc.setFillColor(...pur);doc.circle(x+bw*p,ty+1.2,2,'F');ty+=7;
 doc.setFont('helvetica','normal');doc.setFontSize(9);doc.setTextColor(...dim);doc.text(money(lo),x,ty);doc.text(money(hi),x+bw,ty,{align:'right'});ty+=9;
 // facts grid
 const facts=[['Value band',`${money(lo)} - ${money(hi)}`],['Confidence',`${c.conf} / 100 (${tier(c.conf)})`],['Prices used',String(c.prices??'-')],
  ['Published',d(st.last)],['Valid until',st.k==='revoked'?'Revoked':d(st.until)],['Network',c.network==='robinhood-testnet'?'Robinhood Chain testnet':'Robinhood Chain']];
 const cw=tw/2;facts.forEach((f,i)=>{const fx=x+(i%2)*cw,fy=ty+Math.floor(i/2)*12;doc.setFontSize(7.5);doc.setTextColor(...dim);doc.setFont('helvetica','bold');doc.text(f[0].toUpperCase(),fx,fy);
  doc.setFont('helvetica','normal');doc.setFontSize(10);doc.setTextColor(...ink);doc.text(A(f[1]),fx,fy+5)});
 y=Math.max(y+ih,ty+36)+8;
 // onchain history
 doc.setDrawColor(...line);doc.line(M,y,W-M,y);y+=8;doc.setFont('helvetica','bold');doc.setFontSize(11);doc.setTextColor(...ink);doc.text('Onchain history',M,y);y+=6;
 const E=(c.ev||[]).slice(0,8);const cols=[M,M+30,M+52,M+76,M+100];doc.setFontSize(7.5);doc.setTextColor(...dim);
 ['PUBLISHED (UTC)','LOW','POINT','HIGH','TRANSACTION'].forEach((h,i)=>doc.text(h,cols[i],y));y+=2;doc.line(M,y,W-M,y);y+=5;
 doc.setFont('courier','normal');doc.setFontSize(8);doc.setTextColor(...ink);
 if(!E.length){doc.setFont('helvetica','normal');doc.text('No onchain record found for this cert.',M,y);y+=6}
 E.forEach(e=>{doc.text(e.t.slice(0,16).replace('T',' '),cols[0],y);doc.text(money(e.low),cols[1],y);doc.text(money(e.point),cols[2],y);doc.text(money(e.high),cols[3],y);
  doc.text(A(`${e.tx.slice(0,18)}...${e.tx.slice(-8)}`),cols[4],y);y+=5.2});
 if((c.ev||[]).length>8){doc.setFont('helvetica','normal');doc.setTextColor(...dim);doc.text(`+ ${(c.ev||[]).length-8} earlier records on the certificate page`,M,y);y+=5}
 if(E[0]){doc.setFont('helvetica','normal');doc.setFontSize(7.5);doc.setTextColor(...dim);doc.text(A(`Registry ${E[0].registry} | ${E[0].explorer}`),M,y+1);y+=6}
 // QR + verify
 y+=4;doc.setDrawColor(...line);doc.line(M,y,W-M,y);y+=6;const qs=34;
 if(assets.qr)try{doc.addImage(assets.qr,'PNG',M,y,qs,qs)}catch(e){}
 const vx=M+(assets.qr?qs+8:0);doc.setFont('helvetica','bold');doc.setFontSize(11);doc.setTextColor(...ink);doc.text('Check this record',vx,y+6);
 doc.setFont('helvetica','normal');doc.setFontSize(9);doc.setTextColor(...dim);
 const url=base+c.cert;doc.textWithLink(A(url),vx,y+12,{url});
 doc.text(doc.splitTextToSize('Scan the code or open the link. The live page and the onchain record are the source of truth; this PDF is a snapshot.',W-M-vx),vx,y+18);
 y+=qs+6;
 // basis + limits
 doc.setFontSize(7.5);doc.setTextColor(...dim);
 const basis=c.priceBasis==='sold'?'Price basis: completed sales, normalised by grade.':'Price basis: asking prices and insured values from public marketplace listings, normalised by grade. These are not completed sales.';
 const lim='A Gacha Mark checks the cert, the card details and the price. It does not physically inspect the card and does not prove authenticity, ownership, custody or a sale price. Authenticity rests on the grading company.';
 const foot=doc.splitTextToSize(basis+' '+lim,W-2*M);doc.text(foot,M,Math.min(y,H-26));
 doc.setFontSize(7);doc.text(A(`Generated ${new Date(now).toISOString().slice(0,16).replace('T',' ')} UTC from the live certificate record.`),M,H-10);
 doc.text('gachagalaxy.io',W-M,H-10,{align:'right'});
 // watermarks
 const wm=st.k==='revoked'?'REVOKED':test?'PRE-PRODUCTION':null;
 if(wm){doc.saveGraphicsState&&doc.saveGraphicsState();try{doc.setGState(new doc.GState({opacity:.09}))}catch(e){}
  doc.setFont('helvetica','bold');doc.setFontSize(st.k==='revoked'?96:62);doc.setTextColor(...(st.k==='revoked'?amb:pur));doc.text(wm,W/2,H/2+20,{align:'center',angle:35});
  doc.restoreGraphicsState&&doc.restoreGraphicsState()}
 if(test){doc.setFont('helvetica','bold');doc.setFontSize(7.5);doc.setTextColor(...amb);doc.text('Pre-production record on Robinhood Chain testnet. Not a production Gacha Mark.',M,H-15)}
 return doc}
if(typeof module!=='undefined')module.exports={buildMarkPdf,markPdfStatus,markPdfAscii};
