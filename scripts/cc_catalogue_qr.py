"""Private authorised catalogue scan. No QR navigation or grading-service calls."""
import argparse, collections, concurrent.futures, hashlib, ipaddress, json, os
import re, socket, sqlite3, sys, time, urllib.error, urllib.parse, urllib.request
import resource, signal, subprocess, tempfile, threading
from datetime import datetime, timezone
from pathlib import Path
from slab_consistency import qr_check, cert_number

BASE = 'https://cc-proxy.matthew-dd0.workers.dev/marketplace'
ROOT = Path('/tmp/opencode/cc_catalogue_audit_by_id')
MAX_BYTES = 32 * 1024 * 1024
DECODER_TIMEOUT = 15
DECODER_MEMORY = 768 * 1024 * 1024
DECODER_OUTPUT = 64 * 1024
DECODER_SLOTS = threading.BoundedSemaphore(3)
QUARANTINE_LOCK = threading.Lock()
QUARANTINE = {}
HOSTS = {'arweave.net', 'nft.collectorcrypt.com', 'dilxwvfkfup17.cloudfront.net',
         'd1xpxki1g4htqu.cloudfront.net', 'd1htnxwo4o0jhw.cloudfront.net',
         'ccg-imaging-cgc-tradingcards-production.s3.amazonaws.com'}

def now():
    return datetime.now(timezone.utc).isoformat()

def connect(root=ROOT):
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / 'audit.sqlite')
    db.execute('PRAGMA journal_mode=WAL')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS state(k TEXT PRIMARY KEY,v TEXT);
      CREATE TABLE IF NOT EXISTS pages(n INTEGER PRIMARY KEY, requested_cursor TEXT,
        next_cursor TEXT, captured_at TEXT, server_date TEXT, row_count INTEGER,
        new_count INTEGER, duplicate_count INTEGER, body_sha256 TEXT, metadata TEXT);
      CREATE TABLE IF NOT EXISTS listings(id TEXT PRIMARY KEY,item_id TEXT, company TEXT,
        cert TEXT,back_url TEXT,front_url TEXT,captured_at TEXT,first_page INTEGER,raw TEXT);
      CREATE TABLE IF NOT EXISTS observations(url TEXT PRIMARY KEY,sha256 TEXT,status TEXT,
        observed_at TEXT,data TEXT);
      CREATE TABLE IF NOT EXISTS attempts(seq INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT,
        started_at TEXT,finished_at TEXT,status TEXT,download_attempted INTEGER,
        download_succeeded INTEGER,bytes INTEGER);
      CREATE TABLE IF NOT EXISTS results(listing_id TEXT PRIMARY KEY,url TEXT,status TEXT,
        qr_status TEXT,comparison TEXT,checked_at TEXT,data TEXT);
      CREATE TABLE IF NOT EXISTS decoder_quarantine(sha256 TEXT PRIMARY KEY,status TEXT,
        observed_at TEXT,data TEXT);
    ''')
    return db

def state(db,k,default=None):
    x=db.execute('SELECT v FROM state WHERE k=?',(k,)).fetchone()
    return json.loads(x[0]) if x else default

def setstate(db,k,v):
    db.execute('INSERT OR REPLACE INTO state VALUES(?,?)',(k,json.dumps(v)))

def identity(row):
    # Marketplace receipts may bundle several cards. Source `id` identifies
    # each returned catalogue listing record; receipt is metadata, not identity.
    return 'source_id:' + str(row['id'])

def save_page(db,d,cursor,server_date=None):
    if not isinstance(d,dict) or not isinstance(d.get('filterNFtCard'),list):
        raise ValueError('Invalid catalogue envelope')
    rows=d['filterNFtCard']; nxt=d.get('nextCursor'); stamp=now()
    if nxt is not None and not isinstance(nxt,str):
        raise ValueError('Non-string cursor')
    if nxt and (nxt == cursor or db.execute('SELECT 1 FROM pages WHERE requested_cursor=?',(nxt,)).fetchone()):
        raise ValueError('Cursor cycle; checkpoint unchanged')
    n=db.execute('SELECT COUNT(*) FROM pages').fetchone()[0]+1
    new=0
    with db:
        for r in rows:
            if not isinstance(r,dict) or not r.get('id'):
                raise ValueError('Row missing stable item ID')
            key=identity(r)
            new += db.execute('INSERT OR IGNORE INTO listings VALUES(?,?,?,?,?,?,?,?,?)',
                (key,str(r['id']),r.get('gradingCompany'),str(r.get('gradingID') or ''),
                 r.get('backImage'),r.get('frontImage'),stamp,n,json.dumps(r))).rowcount
        db.execute('INSERT INTO pages VALUES(?,?,?,?,?,?,?,?,?,?)',
            (n,cursor,nxt,stamp,server_date,len(rows),new,len(rows)-new,
             hashlib.sha256(json.dumps(d,sort_keys=True).encode()).hexdigest(),
             json.dumps({k:v for k,v in d.items() if k not in ('filterNFtCard','nextCursor')})))
        setstate(db,'cursor',nxt)
        setstate(db,'catalogue_complete',not bool(nxt))
        setstate(db,'catalogue_stop','natural_end_no_next_cursor' if not nxt else 'in_progress')
    return n,len(rows),new,nxt

def fetch_page(cursor):
    params={'orderBy':'listedDateDesc','step':200,'categories':'Pokemon'}
    if cursor: params['cursor']=cursor
    # Credential is read programmatically and never logged or retained in outputs.
    key=Path('/home/user/.secrets/cc_proxy_key').read_text().strip()
    req=urllib.request.Request(BASE+'?'+urllib.parse.urlencode(params),
        headers={'x-cc-key':key,'User-Agent':'Private authorised catalogue QR audit'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req,timeout=50) as response:
                return json.load(response),response.headers.get('Date')
        except (OSError,ValueError) as exc:
            if attempt==3: raise RuntimeError('Catalogue fetch failed: '+type(exc).__name__) from None
            time.sleep(2**attempt)

def catalogue(db,seconds):
    deadline=time.monotonic()+seconds
    if not state(db,'catalogue_started'): 
        with db: setstate(db,'catalogue_started',now())
    try:
        while not state(db,'catalogue_complete',False) and time.monotonic()<deadline:
            cursor=state(db,'cursor')
            d,date=fetch_page(cursor)
            n,count,new,nxt=save_page(db,d,cursor,date)
            if n%10==0 or not nxt:
                print(json.dumps({'phase':'catalogue','page':n,'rows':count,'new':new,
                    'unique':db.execute('SELECT COUNT(*) FROM listings').fetchone()[0],
                    'complete':not bool(nxt)}),flush=True)
        if not state(db,'catalogue_complete',False):
            with db: setstate(db,'catalogue_stop','time_budget_resumable')
    except Exception as exc:
        with db: setstate(db,'catalogue_stop',str(exc))
        print(json.dumps({'catalogue_error':str(exc)}),flush=True)

def validate_url(url):
    u=urllib.parse.urlsplit(url)
    allowed=u.hostname in HOSTS or (u.hostname and u.hostname.endswith('.arweave.net'))
    if (u.scheme!='https' or not allowed or u.username or u.password
        or u.port not in (None,443)):
        raise ValueError('Unapproved image URL host/scheme/credentials/port')
    addresses=socket.getaddrinfo(u.hostname,443,type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(x[4][0]).is_global for x in addresses):
        raise ValueError('Non-public image host address')
    return url

class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        validate_url(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

def decode(im):
    import cv2
    h,w=im.shape[:2]; detector=cv2.QRCodeDetector()
    def bounded(x,side):
        a,b=x.shape[:2]; scale=min(1.0,side/max(a,b))
        return cv2.resize(x,None,fx=scale,fy=scale) if scale<1 else x
    full=bounded(im,1800)
    top=im[:max(1,int(h*.42)),:]; bottom=im[int(h*.58):,:]
    variants=[full,bounded(top,1800),bounded(bottom,1600),
              bounded(im,1000),cv2.rotate(bounded(top,1400),cv2.ROTATE_180)]
    # Fixed attempts, bounded working resolution; no QR destination is requested.
    if max(top.shape[:2])<1100:
        variants.append(cv2.resize(top,None,fx=2,fy=2))
    for image in variants:
        try:
            text,_,_=detector.detectAndDecode(image)
        except cv2.error:
            continue
        if text: return text
    return None

def decoder_worker(source, destination):
    # Limits are installed by the exec'd child itself, never by preexec_fn in
    # the threaded downloader. Native image parsing is isolated too.
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (DECODER_MEMORY, DECODER_MEMORY))
    resource.setrlimit(resource.RLIMIT_CPU, (12, 13))
    resource.setrlimit(resource.RLIMIT_FSIZE, (DECODER_OUTPUT, DECODER_OUTPUT))
    import cv2
    import numpy as np
    cv2.setNumThreads(1)
    try:
        im=cv2.imdecode(np.fromfile(source,dtype=np.uint8),cv2.IMREAD_REDUCED_COLOR_2)
        if im is None: raise ValueError('Image format decode failed')
        text=decode(im)
        result={'status':'decoded' if text else 'unreadable','qr_text':text,
                'decoded_dimensions':[im.shape[1],im.shape[0]],
                'decoder_limits':{'address_space_bytes':resource.getrlimit(resource.RLIMIT_AS)[0],
                    'cpu_seconds':resource.getrlimit(resource.RLIMIT_CPU)[0],
                    'output_bytes':resource.getrlimit(resource.RLIMIT_FSIZE)[0],
                    'core_bytes':resource.getrlimit(resource.RLIMIT_CORE)[0]}}
        if len(json.dumps(result).encode())>DECODER_OUTPUT:
            raise ValueError('Decoder output exceeds ceiling')
    except Exception as exc:
        result={'status':'decoder_error','error':type(exc).__name__+': '+str(exc)[:250]}
    Path(destination).write_text(json.dumps(result))

def run_decoder(data, timeout=DECODER_TIMEOUT, command=None):
    # No pipes: stdout/stderr go to /dev/null; only a size-checked result file
    # is read. A new exec worker replaces every completed or failed worker.
    with DECODER_SLOTS, tempfile.TemporaryDirectory(prefix='cc-qr-') as folder:
        source=Path(folder)/'image'; destination=Path(folder)/'result.json'
        source.write_bytes(data)
        env=dict(os.environ, OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1',
                 MKL_NUM_THREADS='1', OPENCV_FOR_THREADS_NUM='1')
        args=command if command is not None else [sys.executable,str(Path(__file__).resolve()),
                    '_decode_worker',str(source),str(destination)]
        started=time.monotonic()
        child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL,env=env,start_new_session=True)
        try:
            code=child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try: os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            child.wait()
            return {'status':'decoder_timeout','decoder_exit_code':child.returncode,
                    'decoder_attempts':1,'decoder_elapsed_seconds':round(time.monotonic()-started,3)}
        metadata={'decoder_exit_code':code,'decoder_attempts':1,
                  'decoder_elapsed_seconds':round(time.monotonic()-started,3)}
        if code:
            return dict(metadata,status='decoder_crash' if code<0 else 'decoder_error')
        try:
            if destination.stat().st_size>DECODER_OUTPUT: raise ValueError('Oversize decoder response')
            result=json.loads(destination.read_text())
            if result.get('status') not in ('decoded','unreadable','decoder_error'):
                raise ValueError('Invalid decoder response')
            if (result['status']=='decoded') != bool(result.get('qr_text')):
                raise ValueError('Invalid decoder payload')
            if result.get('qr_text') is not None and not isinstance(result['qr_text'],str):
                raise ValueError('Non-string decoder payload')
            return dict(result,**metadata)
        except (OSError,ValueError,TypeError,AttributeError):
            return dict(metadata,status='decoder_error',error='Invalid bounded worker response')

def isolated_decode(data, digest):
    # Serialise only the quarantine lookup/claim, not unrelated decoding.
    # An in-flight same-hash job waits for its owner's bounded worker result.
    with QUARANTINE_LOCK:
        entry=QUARANTINE.get(digest)
        if entry is None:
            event=threading.Event(); QUARANTINE[digest]=event; owner=True
        else: owner=False
    if not owner:
        if isinstance(entry, threading.Event):
            entry.wait(DECODER_TIMEOUT+5)
            with QUARANTINE_LOCK: entry=QUARANTINE.get(digest)
        if isinstance(entry,dict):
            return dict(entry,decoder_attempts=0,decoder_quarantine_reused=True)
        return {'status':'decoder_timeout','decoder_attempts':0,'decoder_quarantine_reused':True}
    try:
        result=run_decoder(data)
    except Exception:
        result={'status':'decoder_error','decoder_attempts':0,'error':'Worker launch/supervision failed'}
    with QUARANTINE_LOCK:
        # Keep failures for the entire run; successes need no in-memory cache.
        QUARANTINE[digest]=result
        event.set()
    return result

def image_job(url):
    result={'url':url,'started_at':now(),'download_attempted':False,'download_succeeded':False}
    started=time.monotonic()
    try:
        validate_url(url)
        result['download_attempted']=True
        opener=urllib.request.build_opener(SafeRedirect())
        req=urllib.request.Request(url,headers={'User-Agent':'Private authorised partner image QR audit'})
        with opener.open(req,timeout=18) as response:
            length=response.headers.get('Content-Length')
            result['content_length']=length
            result['content_type']=response.headers.get('Content-Type')
            if length and int(length)>MAX_BYTES: raise ValueError('Image exceeds 32 MiB ceiling')
            data=bytearray()
            while True:
                if time.monotonic()-started>45: raise TimeoutError('Image total download time exceeded')
                chunk=response.read(min(128*1024,MAX_BYTES+1-len(data)))
                if not chunk: break
                data.extend(chunk)
                if len(data)>MAX_BYTES: raise ValueError('Image exceeds 32 MiB ceiling')
            result['bytes']=len(data)
            if length and len(data)!=int(length): raise ValueError('Incomplete Content-Length body')
            result['download_succeeded']=True
            result['sha256']=hashlib.sha256(data).hexdigest()
        result.update(isolated_decode(data,result['sha256']))
        del data
    except Exception as exc:
        result['status']='failed'
        result['error']=type(exc).__name__+': '+str(exc)[:250]
    result['observed_at']=now()
    return result

def seed_cache(db):
    path=Path('/tmp/opencode/cc_qr_audit_results.json')
    if not path.exists(): return
    with db:
        for x in json.loads(path.read_text()):
            # Only positive exact-URL observations can be reused. Unreadables retry.
            if x.get('qr_text') and x.get('back_url'):
                v=dict(x,status='decoded',observed_at=None,provenance='legacy_exact_url_cache',
                       cache_file_mtime=datetime.fromtimestamp(path.stat().st_mtime,timezone.utc).isoformat(),
                       legacy_download_completeness_unverified=True)
                db.execute('INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?)',
                    (x['back_url'],None,'decoded',None,json.dumps(v)))

def record_result(db,row,obs):
    id,company,cert,url=row
    qr=qr_check(cert_number(cert),obs)
    if obs['status'].startswith('decoder_'):
        qr=dict(qr,status='not_checked',reason='Decoder infrastructure failure; QR readability not determined')
    if company!='PSA' and obs.get('qr_text'):
        # Existing source-neutral parser's named format rules are PSA-specific.
        # Do not invent a CGC format pass: preserve raw QR and request format review.
        qr=dict(qr,status='review_needed',signals=['non_psa_format_review'],reason='Non-PSA payload retained; PSA path rules do not establish this issuer format')
        # Compare observed CGC cert path literally, without following the link or
        # asserting that the destination/format proves authenticity.
        try:
            u=urllib.parse.urlsplit(obs['qr_text'])
            parsed=re.fullmatch(r'/certlookup/([0-9]+)/[0-9]+_[0-9]+/?',u.path,re.I)
            if company=='CGC' and parsed:
                qr['qr_cert']=parsed.group(1)
                qr['cert_comparison']='match' if parsed.group(1)==cert else 'mismatch'
        except ValueError:
            pass
    output={'observation':obs,'qr':qr,'grading_company':company,'cert':cert,
            'authenticity':'not_determined','psa_calls':0}
    db.execute('INSERT OR IGNORE INTO results VALUES(?,?,?,?,?,?,?)',
        (id,url,obs['status'],qr['status'],qr.get('cert_comparison'),now(),json.dumps(output)))

def scan(db,seconds,workers=3,stop_event=None):
    if not 1<=workers<=3: raise ValueError('Workers must be between 1 and 3')
    stop_event=stop_event or threading.Event()
    seed_cache(db)
    with QUARANTINE_LOCK:
        QUARANTINE.clear()
        for digest,raw in db.execute('SELECT sha256,data FROM decoder_quarantine'):
            QUARANTINE[digest]=json.loads(raw)
    deadline=time.monotonic()+seconds
    with db:
        setstate(db,'image_scan_started',state(db,'image_scan_started',now()))
        setstate(db,'scan_parameters',{'workers':workers,'image_budget_seconds':seconds,
                 'decoder_timeout_seconds':DECODER_TIMEOUT,'decoder_memory_bytes':DECODER_MEMORY,
                 'decoder_attempts_per_new_hash':1,'decoder_output_ceiling_bytes':DECODER_OUTPUT})
        setstate(db,'image_scan_stop','running')
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        while time.monotonic()<deadline and not stop_event.is_set():
            rows=db.execute('''SELECT l.id,l.company,l.cert,l.back_url FROM listings l
                LEFT JOIN results r ON r.listing_id=l.id WHERE r.listing_id IS NULL
                ORDER BY l.first_page,l.rowid LIMIT ?''',(workers,)).fetchall()
            if not rows: break
            jobs={}; observations={}
            for row in rows:
                url=row[3]
                if not url:
                    observations[url]={'status':'no_back_photo','observed_at':now()}
                elif url not in jobs and url not in observations:
                    cached=db.execute('SELECT data FROM observations WHERE url=?',(url,)).fetchone()
                    if cached:
                        observations[url]=json.loads(cached[0])
                    else: jobs[url]=pool.submit(image_job,url)
            for url,future in jobs.items():
                obs=future.result(); observations[url]=obs
                with db:
                    db.execute('INSERT OR REPLACE INTO observations VALUES(?,?,?,?,?)',
                        (url,obs.get('sha256'),obs['status'],obs['observed_at'],json.dumps(obs)))
                    db.execute('INSERT INTO attempts(url,started_at,finished_at,status,download_attempted,download_succeeded,bytes) VALUES(?,?,?,?,?,?,?)',
                        (url,obs['started_at'],obs['observed_at'],obs['status'],int(obs['download_attempted']),int(obs['download_succeeded']),obs.get('bytes',0)))
                    if obs['status'].startswith('decoder_') and obs.get('sha256'):
                        db.execute('INSERT OR IGNORE INTO decoder_quarantine VALUES(?,?,?,?)',
                            (obs['sha256'],obs['status'],obs['observed_at'],json.dumps({k:v for k,v in obs.items() if k.startswith('decoder_') or k in ('status','error')})))
            with db:
                for row in rows: record_result(db,row,observations[row[3]])
                setstate(db,'image_scan_checkpoint',now())
            with QUARANTINE_LOCK:
                for obs in observations.values():
                    if not obs['status'].startswith('decoder_'):
                        QUARANTINE.pop(obs.get('sha256'),None)
            count=db.execute('SELECT COUNT(*) FROM results').fetchone()[0]
            if count%240==0:
                print(json.dumps({'phase':'images','processed_listings':count,
                    'statuses':dict(db.execute('SELECT status,COUNT(*) FROM results GROUP BY status'))}),flush=True)
    with db: setstate(db,'image_scan_stop','all_records_processed' if not db.execute('SELECT 1 FROM listings l LEFT JOIN results r ON r.listing_id=l.id WHERE r.listing_id IS NULL LIMIT 1').fetchone() else ('graceful_signal_stop' if stop_event.is_set() else 'time_budget_resumable'))

def report(db):
    scalar=lambda q: db.execute(q).fetchone()[0]
    group=lambda q: dict(db.execute(q).fetchall())
    summary={'generated_at':now(),'catalogue_complete':state(db,'catalogue_complete',False),
      'catalogue_stop':state(db,'catalogue_stop'),'image_scan_stop':state(db,'image_scan_stop'),
      'pages':scalar('SELECT COUNT(*) FROM pages'),'source_rows':scalar('SELECT COALESCE(SUM(row_count),0) FROM pages'),
      'duplicate_listing_rows':scalar('SELECT COALESCE(SUM(duplicate_count),0) FROM pages'),
      'listing_records':scalar('SELECT COUNT(*) FROM listings'),
      'identity_fallback_item_records':scalar("SELECT COUNT(*) FROM listings WHERE id LIKE 'item:%'"),
      'unique_nonempty_cert_strings':scalar("SELECT COUNT(DISTINCT cert) FROM listings WHERE cert!=''"),
      'unique_issuer_cert_pairs':scalar("SELECT COUNT(*) FROM (SELECT DISTINCT company,cert FROM listings WHERE cert!='')"),
      'companies':group('SELECT company,COUNT(*) FROM listings GROUP BY company'),
      'back_photos_present':scalar("SELECT COUNT(*) FROM listings WHERE back_url IS NOT NULL AND back_url!=''"),
      'processed_listing_records':scalar('SELECT COUNT(*) FROM results'),
      'listing_statuses':group('SELECT status,COUNT(*) FROM results GROUP BY status'),
      'qr_statuses':group('SELECT qr_status,COUNT(*) FROM results GROUP BY qr_status'),
      'exact_cert_comparisons':group("SELECT COALESCE(comparison,'not_comparable'),COUNT(*) FROM results GROUP BY comparison"),
      'image_attempt_records':scalar('SELECT COUNT(*) FROM attempts'),
      'downloads_attempted':scalar('SELECT COALESCE(SUM(download_attempted),0) FROM attempts'),
      'downloads_succeeded':scalar('SELECT COALESCE(SUM(download_succeeded),0) FROM attempts'),
      'download_bytes':scalar('SELECT COALESCE(SUM(bytes),0) FROM attempts'),
      'attempt_statuses':group('SELECT status,COUNT(*) FROM attempts GROUP BY status'),
      'source_capture_range':db.execute('SELECT MIN(captured_at),MAX(captured_at) FROM pages').fetchone(),
      'source_server_date_range':db.execute('SELECT MIN(server_date),MAX(server_date) FROM pages').fetchone(),
      'psa_calls':0,'qr_links_followed':0,
      'denominators':{'catalogue':'Distinct source catalogue record id; receiptId retained as metadata, not identity; includes unpriced records',
        'unique_certs':'Nonempty raw cert strings across all issuers; issuer+cert pairs also reported',
        'listing_statuses':'Processed listing records, not unique certs or unique URLs',
        'downloads':'Network attempts this run series, counted once per fetched URL, including failures; excludes reused cache',
        'qr_statuses':'slab_consistency.qr_check raw exact PSA cert/format checks; non-PSA decoded payloads marked review',
      'comparison':'Exact parsed PSA path cert versus source cert; review status can coexist with exact match'},
      'limitations':['Live cursor traversal is not an atomic marketplace snapshot',
        'Back photos scanned; front URLs retained but front-only photos not scanned',
        'No physical authenticity verdict; CGC and other non-PSA decoded formats require review']}
    signals=collections.Counter(); legacy=0
    for (raw,) in db.execute('SELECT data FROM results'):
        r=json.loads(raw); signals.update(r['qr']['signals'])
        legacy+=r['observation'].get('provenance')=='legacy_exact_url_cache'
    summary['named_qr_signals']=dict(signals); summary['legacy_cache_reused_listing_records']=legacy
    summary['denominators']['comparison']='Exact parsed cert string versus source cert: PSA cert path or observed CGC certlookup path; CGC format remains review-only'
    summary['image_scan_checkpoint']=state(db,'image_scan_checkpoint')
    summary['scan_parameters']={'workers':3,'image_size_ceiling_bytes':MAX_BYTES,
       'request_timeout_seconds':18,'download_elapsed_ceiling_seconds':45,
        'image_budget_seconds':1800,'qr_rules':'slab_consistency.qr_check plus literal CGC path extraction; no navigation'}
    summary['scan_parameters'].update(state(db,'scan_parameters',{}))
    summary['current_failure_reasons']=dict(collections.Counter(
       json.loads(x[0])['observation'].get('error') for x in db.execute("SELECT data FROM results WHERE status='failed'")))
    summary['processed_by_company']={str(k):dict(db.execute('SELECT status,COUNT(*) FROM results WHERE listing_id IN (SELECT id FROM listings WHERE company IS ?) GROUP BY status',(k,)))
       for (k,) in db.execute('SELECT DISTINCT company FROM listings')}
    summary['pending_listing_records']=summary['listing_records']-summary['processed_listing_records']
    path=ROOT/'summary.json'; tmp=ROOT/'summary.tmp'
    tmp.write_text(json.dumps(summary,indent=2)); tmp.replace(path)
    return summary

def main():
    if len(sys.argv)==4 and sys.argv[1]=='_decode_worker':
        decoder_worker(sys.argv[2],sys.argv[3]); return
    p=argparse.ArgumentParser(); p.add_argument('mode',choices=['catalogue','scan','report']);p.add_argument('--seconds',type=int,default=2400)
    p.add_argument('--workers',type=int,default=3)
    a=p.parse_args(); db=connect()
    if a.mode=='catalogue': catalogue(db,a.seconds)
    if a.mode=='scan':
        stop=threading.Event()
        for sig in (signal.SIGINT,signal.SIGTERM): signal.signal(sig,lambda *_:stop.set())
        scan(db,a.seconds,a.workers,stop)
    print(json.dumps(report(db),indent=2),flush=True)

if __name__=='__main__': main()
