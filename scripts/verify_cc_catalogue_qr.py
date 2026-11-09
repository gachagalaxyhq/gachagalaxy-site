"""Independent read-only recomputation of private audit invariants."""
import collections, hashlib, json, sqlite3
from pathlib import Path
from datetime import datetime, timezone

ROOT=Path('/tmp/opencode/cc_catalogue_audit_by_id')

def verify():
    db=sqlite3.connect('file:'+str(ROOT/'audit.sqlite')+'?mode=ro',uri=True)
    db.execute('BEGIN')
    assertions={}; categories=collections.Counter();companies=collections.Counter()
    certs=set();issuer_certs=set(); ids=set();back=0;grade_fields=0;source_times=collections.defaultdict(list)
    for key,item,company,cert,back_url,front_url,captured,page,raw in db.execute('SELECT * FROM listings'):
        row=json.loads(raw)
        assert key=='source_id:'+str(row['id']) and item==str(row['id'])
        assert key not in ids;ids.add(key)
        assert row.get('backImage')==back_url and row.get('frontImage')==front_url
        assert str(row.get('gradingID') or '')==cert and row.get('gradingCompany')==company
        categories[str(row.get('category'))]+=1;companies[str(company)]+=1
        if cert: certs.add(cert);issuer_certs.add((company,cert))
        if back_url: back+=1
        grade_fields+=('grade' in row and 'gradeNum' in row)
        for field in ('listedAt','createdAt','updatedAt'):
            if isinstance(row.get(field),str):source_times[field].append(row[field])
    assertions['all_records_source_id_unique']=True
    assertions['retained_urls_cert_company_equal_source']=True
    assertions['all_categories_pokemon']=set(categories)=={'Pokemon'}
    assert assertions['all_categories_pokemon']
    pages=db.execute('SELECT n,requested_cursor,next_cursor,row_count,new_count,duplicate_count FROM pages ORDER BY n').fetchall()
    for i,p in enumerate(pages):
        assert p[0]==i+1 and p[3]==p[4]+p[5]
        assert p[1]==(pages[i-1][2] if i else None)
    assert sum(p[4] for p in pages)==len(ids)
    complete=json.loads(db.execute("SELECT v FROM state WHERE k='catalogue_complete'").fetchone()[0])
    assert not complete or (pages and not pages[-1][2])
    assertions['pagination_chain_and_counts_consistent']=True
    statuses=collections.Counter();qr_statuses=collections.Counter();comparisons=collections.Counter()
    by_company=collections.defaultdict(collections.Counter);signals=collections.Counter();missing=[]
    legacy=0;errors=collections.Counter(); exact=collections.Counter()
    for key,url,status,qr_status,comparison,stamp,raw in db.execute('SELECT * FROM results'):
        assert key in ids
        row=json.loads(raw);obs=row['observation'];qr=row['qr']
        assert status==obs['status'] and qr_status==qr['status'] and comparison==qr.get('cert_comparison')
        assert row['psa_calls']==0 and row['authenticity']=='not_determined'
        assert status!='decoded' or bool(obs.get('qr_text'))
        assert status!='unreadable' or not obs.get('qr_text')
        if status.startswith('decoder_'):
            assert not obs.get('qr_text') and qr_status=='not_checked' and comparison is None
        if comparison:
            independent='match' if qr['qr_cert']==row['cert'] else 'mismatch'
            assert comparison==independent;exact[comparison]+=1
        statuses[status]+=1;qr_statuses[qr_status]+=1;comparisons[comparison or 'not_comparable']+=1
        by_company[str(row['grading_company'])][status]+=1
        signals.update(qr['signals']);legacy+=obs.get('provenance')=='legacy_exact_url_cache'
        if obs.get('error'):errors[obs['error']]+=1
    assertions['result_status_and_exact_comparison_recomputed']=True
    assertions['decoded_unreadable_not_conflated']=True
    assertions['no_authenticity_verdict_or_psa_calls_in_results']=True
    attempts=db.execute('SELECT status,download_attempted,download_succeeded,bytes FROM attempts').fetchall()
    assert all(not success or attempted for _,attempted,success,_ in attempts)
    assertions['download_attempt_denominators_consistent']=True
    integrity=db.execute('PRAGMA integrity_check').fetchone()[0];assert integrity=='ok'
    assertions['sqlite_integrity_ok']=True
    for url,digest,status,stamp,raw in db.execute('SELECT * FROM observations'):
        obs=json.loads(raw)
        assert obs['status']==status and obs.get('sha256')==digest
        assert not status.startswith('decoder_') or not obs.get('qr_text')
    assertions['observation_status_hash_consistent']=True
    for digest,status,stamp,raw in db.execute('SELECT * FROM decoder_quarantine'):
        obs=json.loads(raw)
        assert status.startswith('decoder_') and obs['status']==status
        assert len(digest)==64 and obs.get('decoder_attempts',0)<=1
    assertions['decoder_failures_separate_and_quarantined']=True
    assert not db.execute('SELECT 1 FROM results r JOIN listings l ON r.listing_id=l.id WHERE r.url IS NOT l.back_url AND NOT (r.url IS NULL AND l.back_url=\'\') LIMIT 1').fetchone()
    assertions['result_urls_equal_catalogue_back_urls']=True
    output={'verified_at':datetime.now(timezone.utc).isoformat(),'assertions':assertions,
      'catalogue_complete':complete,'pages':len(pages),'source_rows':sum(p[3] for p in pages),
      'duplicate_source_ids':sum(p[5] for p in pages),'listing_records':len(ids),
      'companies':dict(companies),'categories':dict(categories),'unique_cert_strings':len(certs),
      'unique_issuer_cert_pairs':len(issuer_certs),'back_photos_present':back,'records_with_grade_fields':grade_fields,
      'source_timestamp_ranges':{k:[min(v),max(v)] for k,v in source_times.items()},
      'processed_listings':sum(statuses.values()),'pending_listings':len(ids)-sum(statuses.values()),
      'listing_statuses':dict(statuses),'qr_statuses':dict(qr_statuses),'exact_cert_comparisons':dict(comparisons),
      'processed_by_company':{k:dict(v) for k,v in by_company.items()},'named_signals':dict(signals),
      'legacy_positive_cache_listing_records':legacy,'current_failure_reasons':dict(errors),
      'download_attempt_records':len(attempts),'downloads_attempted':sum(x[1] for x in attempts),
      'downloads_succeeded':sum(x[2] for x in attempts),'download_bytes':sum(x[3] or 0 for x in attempts),
      'historical_attempt_statuses':dict(collections.Counter(x[0] for x in attempts))}
    db.rollback();db.close()
    (ROOT/'verification.json').write_text(json.dumps(output,indent=2))
    print(json.dumps(output,indent=2))
    return output

if __name__=='__main__':verify()
