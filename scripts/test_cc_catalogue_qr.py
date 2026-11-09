import importlib.util, io, tempfile, unittest, sys, signal, threading, json, time
from pathlib import Path
from unittest.mock import patch
import cc_catalogue_qr as m

class CatalogueTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.db=m.connect(Path(self.temp.name))
    def tearDown(self): self.db.close();self.temp.cleanup()
    def row(self,item,receipt,cert='12345678'):
        return {'id':item,'listing':{'receiptId':receipt},'gradingID':cert,'gradingCompany':'PSA','category':'Pokemon'}
    def test_dedupe_listing_not_cert(self):
        m.save_page(self.db,{'filterNFtCard':[self.row('a','x'),self.row('b','y')],'nextCursor':'c'},None)
        m.save_page(self.db,{'filterNFtCard':[self.row('a','x'),self.row('c','z')],'nextCursor':None},'c')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM listings').fetchone()[0],3)
        self.assertEqual(self.db.execute('SELECT SUM(duplicate_count) FROM pages').fetchone()[0],1)
    def test_short_page_still_continues(self):
        m.save_page(self.db,{'filterNFtCard':[self.row('a','x')],'nextCursor':'next'},None)
        self.assertFalse(m.state(self.db,'catalogue_complete'));self.assertEqual(m.state(self.db,'cursor'),'next')
    def test_shared_receipts_keep_distinct_source_ids(self):
        m.save_page(self.db,{'filterNFtCard':[self.row('a','shared'),self.row('b','shared')],'nextCursor':None},None)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM listings').fetchone()[0],2)
    def test_empty_page_cursor_continues(self):
        m.save_page(self.db,{'filterNFtCard':[],'nextCursor':'next'},None)
        self.assertFalse(m.state(self.db,'catalogue_complete'))
    def test_transaction_rolls_back(self):
        with self.assertRaises(ValueError):
            m.save_page(self.db,{'filterNFtCard':[self.row('a','x'),{}],'nextCursor':'next'},None)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM listings').fetchone()[0],0)
        self.assertIsNone(m.state(self.db,'cursor'))
    def test_resume_and_natural_end(self):
        m.save_page(self.db,{'filterNFtCard':[self.row('a','x')],'nextCursor':'next'},None)
        self.db.close();self.db=m.connect(Path(self.temp.name))
        self.assertEqual(m.state(self.db,'cursor'),'next')
        m.save_page(self.db,{'filterNFtCard':[],'nextCursor':None},'next')
        self.assertTrue(m.state(self.db,'catalogue_complete'))
    def test_cursor_cycle_rejected(self):
        m.save_page(self.db,{'filterNFtCard':[],'nextCursor':'a'},None)
        with self.assertRaises(ValueError): m.save_page(self.db,{'filterNFtCard':[],'nextCursor':'a'},'a')
        self.assertEqual(m.state(self.db,'cursor'),'a')
    def test_url_rejects_unapproved_or_private(self):
        for u in ['http://arweave.net/a','https://psacard.com/cert/12345678','https://arweave.net@127.0.0.1/a']:
            with self.assertRaises(ValueError):m.validate_url(u)
        with patch('socket.getaddrinfo',return_value=[(2,1,6,'',('127.0.0.1',443))]):
            with self.assertRaises(ValueError):m.validate_url('https://arweave.net/a')
    def test_exact_not_substring(self):
        x=m.qr_check('12345678',{'qr_text':'https://www.psacard.com/cert/123456789'})
        self.assertEqual(x['status'],'mismatch')
    def test_result_checkpoint_separate_listings(self):
        observation={'status':'decoded','qr_text':'https://www.psacard.com/cert/12345678'}
        with self.db:
            for key in ['listing:x','listing:y']:
                m.record_result(self.db,(key,'PSA','12345678','https://arweave.net/a'),observation)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM results').fetchone()[0],2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM results WHERE qr_status='match'").fetchone()[0],2)
    def test_cgc_literal_cert_keeps_format_review(self):
        m.record_result(self.db,('listing:c','CGC','1234567890','https://arweave.net/a'),
            {'status':'decoded','qr_text':'https://www.cgccards.com/certlookup/1234567890/123_456/'})
        self.assertEqual(self.db.execute('SELECT qr_status,comparison FROM results').fetchone(),('review_needed','match'))
    def fake_image_response(self,payload,length=None):
        class Response(io.BytesIO):
            headers={'Content-Length':str(len(payload) if length is None else length),'Content-Type':'image/jpeg'}
        class Opener:
            def open(self,*args,**kwargs): return Response(payload)
        return Opener()
    def test_full_download_exceeds_old_eight_megabyte_bug(self):
        payload=b'x'*9_000_000
        with patch.object(m,'validate_url'),patch.object(m.urllib.request,'build_opener',return_value=self.fake_image_response(payload)),patch.object(m,'isolated_decode',return_value={'status':'decoded','qr_text':'decoded'}):
            result=m.image_job('https://arweave.net/image')
        self.assertEqual(result['bytes'],len(payload));self.assertTrue(result['download_succeeded'])
        self.assertEqual(result['status'],'decoded')
    def test_incomplete_download_explicit_failure(self):
        with patch.object(m,'validate_url'),patch.object(m.urllib.request,'build_opener',return_value=self.fake_image_response(b'abc',length=9)):
            result=m.image_job('https://arweave.net/image')
        self.assertEqual(result['status'],'failed');self.assertFalse(result['download_succeeded'])
        self.assertIn('Incomplete Content-Length',result['error'])
    def test_oversize_download_explicit_failure(self):
        with patch.object(m,'validate_url'),patch.object(m.urllib.request,'build_opener',return_value=self.fake_image_response(b'',length=m.MAX_BYTES+1)):
            result=m.image_job('https://arweave.net/image')
        self.assertEqual(result['status'],'failed');self.assertIn('32 MiB',result['error'])

    def test_child_abnormal_exit_isolated_and_worker_replaced(self):
        result=m.run_decoder(b'x',command=[sys.executable,'-c',
            'import resource,os,signal; resource.setrlimit(resource.RLIMIT_CORE,(0,0)); os.kill(os.getpid(),signal.SIGSEGV)'])
        self.assertEqual(result['status'],'decoder_crash')
        self.assertEqual(result['decoder_exit_code'],-signal.SIGSEGV)
        self.assertEqual(self.valid_decode()['status'],'decoded')

    def valid_decode(self):
        import qrcode
        buf=io.BytesIO(); qrcode.make('https://www.psacard.com/cert/12345678').save(buf,format='PNG')
        return m.run_decoder(buf.getvalue())

    def test_successful_real_worker_decoding(self):
        result=self.valid_decode()
        self.assertEqual(result['qr_text'],'https://www.psacard.com/cert/12345678')
        self.assertEqual(result['status'],'decoded'); self.assertEqual(result['decoder_exit_code'],0)
        self.assertEqual(result['decoder_limits'],{'address_space_bytes':m.DECODER_MEMORY,
            'cpu_seconds':12,'output_bytes':m.DECODER_OUTPUT,'core_bytes':0})

    def test_child_timeout_killed_reaped_and_replaced(self):
        started=time.monotonic()
        result=m.run_decoder(b'x',timeout=.1,command=[sys.executable,'-c','import time; time.sleep(10)'])
        self.assertEqual(result['status'],'decoder_timeout')
        self.assertEqual(result['decoder_exit_code'],-signal.SIGKILL)
        self.assertLess(time.monotonic()-started,3)
        self.assertEqual(self.valid_decode()['status'],'decoded')

    def test_child_output_not_captured_and_missing_response_rejected(self):
        result=m.run_decoder(b'x',command=[sys.executable,'-c',
              'import os; os.write(1,b"x"*1000000); os.write(2,b"y"*1000000)'])
        self.assertEqual(result['status'],'decoder_error')

    def test_oversize_worker_response_rejected(self):
        code='import pathlib,sys; pathlib.Path(sys.argv[1]).write_text("x"*70000)'
        # run_decoder substitutes no arguments in its test-only command, so use
        # an executable shim that locates the already-created transient folder.
        original=m.subprocess.Popen
        def launch(args,**kwargs):
            return original([sys.executable,'-c',code,args[-1]],**kwargs)
        with patch.object(m.subprocess,'Popen',side_effect=launch):
            self.assertEqual(m.run_decoder(b'x')['status'],'decoder_error')

    def test_invalid_image_not_genuinely_unreadable(self):
        self.assertEqual(m.run_decoder(b'not an image')['status'],'decoder_error')

    def test_real_blank_image_unreadable(self):
        from PIL import Image
        buf=io.BytesIO();Image.new('RGB',(100,100),'white').save(buf,format='PNG')
        self.assertEqual(m.run_decoder(buf.getvalue())['status'],'unreadable')

    def test_same_hash_quarantined_without_retry(self):
        m.QUARANTINE.clear()
        with patch.object(m,'run_decoder',return_value={'status':'decoder_crash','decoder_attempts':1}) as worker:
            first=m.isolated_decode(b'x','poison'); second=m.isolated_decode(b'x','poison')
        self.assertEqual(worker.call_count,1);self.assertEqual(second['decoder_attempts'],0)
        self.assertTrue(second['decoder_quarantine_reused']);m.QUARANTINE.clear()

    def test_cached_photo_checkpoint_resume_and_immutable_results(self):
        rows=[dict(self.row(x,x),backImage='https://arweave.net/shared') for x in ('a','b')]
        m.save_page(self.db,{'filterNFtCard':rows,'nextCursor':None},None)
        obs={'status':'decoder_crash','observed_at':m.now(),'sha256':'poison','decoder_attempts':1}
        with self.db:
            self.db.execute('INSERT INTO observations VALUES(?,?,?,?,?)',
                ('https://arweave.net/shared','poison','decoder_crash',obs['observed_at'],json.dumps(obs)))
        with patch.object(m,'image_job',side_effect=AssertionError('No network allowed')),patch.object(m,'seed_cache'):
            m.scan(self.db,3)
            before=self.db.execute('SELECT * FROM results ORDER BY listing_id').fetchall()
            checkpoint=m.state(self.db,'image_scan_checkpoint')
            self.db.close();self.db=m.connect(Path(self.temp.name))
            m.scan(self.db,3)
        self.assertEqual(len(before),2)
        self.assertEqual(before,self.db.execute('SELECT * FROM results ORDER BY listing_id').fetchall())
        self.assertEqual(checkpoint,m.state(self.db,'image_scan_checkpoint'))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0],0)
        m.record_result(self.db,('source_id:a','PSA','12345678','different'),{'status':'unreadable'})
        self.assertEqual(before,self.db.execute('SELECT * FROM results ORDER BY listing_id').fetchall())

    def test_crash_quarantine_persisted_and_loaded_on_resume(self):
        m.save_page(self.db,{'filterNFtCard':[dict(self.row('a','a'),backImage='https://arweave.net/a')],
                            'nextCursor':None},None)
        obs={'status':'decoder_timeout','url':'https://arweave.net/a','started_at':m.now(),
             'observed_at':m.now(),'download_attempted':True,'download_succeeded':True,
             'sha256':'poison','bytes':1,'decoder_attempts':1}
        with patch.object(m,'image_job',return_value=obs),patch.object(m,'seed_cache'):
            m.scan(self.db,3)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM decoder_quarantine').fetchone()[0],1)
        m.QUARANTINE.clear()
        with patch.object(m,'seed_cache'):m.scan(self.db,3)
        with patch.object(m,'run_decoder',side_effect=AssertionError('Poison must not retry')):
            self.assertEqual(m.isolated_decode(b'x','poison')['decoder_attempts'],0)
        m.QUARANTINE.clear()

    def test_signal_stop_schedules_no_new_work(self):
        stop=threading.Event();stop.set()
        with patch.object(m,'image_job',side_effect=AssertionError('Stopped')),patch.object(m,'seed_cache'):
            m.scan(self.db,3,stop_event=stop)
        self.assertNotEqual(m.state(self.db,'image_scan_stop'),'running')

    def test_invalid_concurrency_rejected(self):
        for workers in (0,4):
            with self.assertRaises(ValueError):m.scan(self.db,1,workers=workers)

if __name__=='__main__':unittest.main()
