"""Create batch-scoped variants of reviewed local tools; no credential reads here."""
from pathlib import Path
import json
ROOT=Path(__file__).resolve().parents[1]
b=json.loads((ROOT/'data/marks-to-18-preparation.json').read_text())
ids=[r['public_row_after_issuance']['cert'] for r in b['records']]
v=(ROOT/'scripts/validate_additional_marks.mjs').read_text().replace('additional-mark-preparation.json','marks-to-18-preparation.json')
(ROOT/'scripts/validate_marks_to_18.mjs').write_text(v)
p=Path('/tmp/opencode/pub')
v=(p/'issue_prepared_six.mjs').read_text()
v=v.replace("const IDS=['158538600','151114672','162925956','120515467','171402573','163541653'];",'const IDS='+json.dumps(ids)+';')
v=v.replace('additional-mark-preparation.json','marks-to-18-preparation.json')
v=v.replace('additional-marks-','marks-to-18-').replace('pre-issuance-','pre-18-')
# Enforce decoded evidence and immutable evidence digests before signing.
v=v.replace("const prior=journal.transactions.find", "check(r.slab_qr_evidence.observation.status==='decoded'&&r.slab_qr_evidence.observation.download_succeeded&&r.slab_qr_evidence.comparison.status==='match'&&r.slab_qr_evidence.comparison.qr_cert===args[1]&&r.slab_qr_evidence.observation.qr_text==='https://www.psacard.com/cert/'+args[1]+'/','DECODED_QR_REQUIREMENT_FAILED');\n  const prior=journal.transactions.find")
(p/'issue_marks_to_18.mjs').write_text(v)
v=(ROOT/'scripts/index_issued_six.py').read_text()
v=v.replace('additional-mark-preparation.json','marks-to-18-preparation.json').replace('additional-marks-','marks-to-18-').replace('pre-issuance-','pre-18-')
v=v.replace("== 6\nfor rel", "== 12\nfor rel")
v=v.replace('certs[:6]','certs[:12]').replace('written[:6]','written[:12]')
v=v.replace("== 12\nsave", "== 18\nsave").replace("== 12\nfor r in handoff", "== 18\nfor r in handoff")
v=v.replace("'total_saved_marks': 12", "'total_saved_marks': 18")
v=v.replace("'indexed_total': 12", "'indexed_total': 18").replace("'old_six_preserved': True", "'old_twelve_preserved': True")
v=v.replace("'evidence_sha256': record['evidence_sha256'],\n            'eligible'", "'evidence_sha256': record['evidence_sha256'],\n            'slab_qr_evidence': record['slab_qr_evidence'], 'qr_decode_status': 'decoded',\n            'eligible'")
(ROOT/'scripts/index_marks_to_18.py').write_text(v)
print(json.dumps({'scoped_ids':ids,'files':['scripts/validate_marks_to_18.mjs','/tmp/opencode/pub/issue_marks_to_18.mjs']}))
