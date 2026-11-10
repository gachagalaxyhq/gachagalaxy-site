"""Exercise the actual renderer in a disposable tree, never the filming tree."""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
INPUTS = ("scripts/render.py", "data/cc.json", "src/certs.json", "src/onchain.json",
          "src/platform.tpl.html", "src/index.tpl.html", "src/chaincheck.js", "src/markpdf.js", "src/card-passport.js",
          # render.py now also inlines the catalogue UI and derives decoded selections from public shards.
          "scripts/build_decoded_catalogue.py", "src/catalogue.js", "src/catalogue-worker.js")
# Read-only catalogue snapshot (~70 MB); linked, never copied or written by render.py.
CATALOGUE = "public/data/catalogue"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def assert_snapshot(test, payload, certs, onchain):
    # Image externalization is intentional; all other fields must survive verbatim.
    without_image = lambda rows: [{k: v for k, v in c.items() if k != "img"} for c in rows]
    test.assertEqual(without_image(payload["certs"]), without_image(certs))
    test.assertEqual(payload["oc"], onchain)


class RenderSnapshotTests(unittest.TestCase):
    def test_actual_render_preserves_sold_snapshot_despite_different_asking_prices(self):
        before = {p: digest(ROOT / p) for p in INPUTS}
        certs = json.loads((ROOT / "src/certs.json").read_text())
        onchain = json.loads((ROOT / "src/onchain.json").read_text())
        with tempfile.TemporaryDirectory(prefix="pricing-render-") as directory:
            root = Path(directory)
            for name in INPUTS:
                destination = root / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, destination)
            # build_decoded_catalogue writes decoded.json, so copy the small files into the disposable
            # tree and only symlink the read-only snapshot shards; nothing in the real tree is writable.
            (root / CATALOGUE).mkdir(parents=True)
            for small in ("manifest.json", "decoded.json"):
                shutil.copyfile(ROOT / CATALOGUE / small, root / CATALOGUE / small)
            base = json.loads((ROOT / CATALOGUE / "manifest.json").read_text())["base_url"].strip("/").split("/")[-1]
            (root / CATALOGUE / base).symlink_to(ROOT / CATALOGUE / base, target_is_directory=True)
            catalogue_before = {p.name: digest(p) for p in (ROOT / CATALOGUE).glob("*.json")}
            cc_path = root / "data/cc.json"
            cc = json.loads(cc_path.read_text())
            # Asset existence, not a stale deployed origin, controls catalogue routing.
            asset = root / 'public/cards' / (cc['cards'][0]['id'] + '.webp')
            asset.parent.mkdir(parents=True, exist_ok=True)
            asset.write_bytes(b'isolated existence check; no image is published')
            # Deliberately synthetic asking values, confined to the disposable copy.
            for c in cc["cards"]:
                for key in ("low", "point", "high", "low_ask"):
                    c[key] = 98765.43
                for listing in c["listings"]:
                    listing["ask"] = 98765.43
            cc_path.write_text(json.dumps(cc))
            # Any accidental network use is a hard failure, not a live API request.
            # sys.path mirrors `python3 scripts/render.py` (render.py imports sibling build_decoded_catalogue).
            runner = ("import runpy,socket,sys; sys.path.insert(0,'scripts'); "
                      "socket.socket=lambda *a,**k: (_ for _ in ()).throw(RuntimeError('network forbidden')); "
                      "runpy.run_path('scripts/render.py',run_name='__main__')")
            rr = subprocess.run([sys.executable, "-c", runner], cwd=root, capture_output=True, text=True)
            self.assertEqual(rr.returncode, 0, rr.stderr[-2000:])
            page = (root / "public/platform.html").read_text()
            payload, _ = json.JSONDecoder().raw_decode(page.split("const D=", 1)[1])
            assert_snapshot(self, payload, certs, onchain)
            self.assertEqual(next(c for c in payload['cards'] if c['i'] == 1)['im'],
                             '/cards/' + cc['cards'][0]['id'] + '.webp')
            self.assertTrue(all(c['img'].startswith('/assets/') for c in payload['certs']))
            own = json.loads((root / 'public/data/own-claims.json').read_text())
            self.assertEqual(len(own), len(certs))
            self.assertEqual(own[0]['card'], certs[0]['name'] + ' ' + certs[0]['num'])
            self.assertEqual(own[0]['when'], max(e['t'] for e in certs[0]['ev']))
            self.assertTrue(all(row['source'] == 'mark' for row in own))
            self.assertTrue(all(c["ga"] == 98765.43 for c in payload["cards"]))
            self.assertEqual(catalogue_before, {p.name: digest(p) for p in (ROOT / CATALOGUE).glob("*.json")})
            self.assertEqual(digest(root / "src/certs.json"), before["src/certs.json"])
            self.assertEqual(digest(root / "src/onchain.json"), before["src/onchain.json"])
            # Prove the guard catches the specific historical failure mode.
            corrupted = copy.deepcopy(payload)
            corrupted["certs"][0]["point"] = 98765.43
            with self.assertRaises(AssertionError):
                assert_snapshot(self, corrupted, certs, onchain)
            corrupted = copy.deepcopy(payload)
            corrupted["oc"]["events"][certs[0]["cert"]][0]["point"] = 98765.43
            with self.assertRaises(AssertionError):
                assert_snapshot(self, corrupted, certs, onchain)
        self.assertEqual(before, {p: digest(ROOT / p) for p in INPUTS})

    def test_authoritative_sold_bands_match_latest_cached_chain_events(self):
        certs = json.loads((ROOT / "src/certs.json").read_text())
        events = json.loads((ROOT / "src/onchain.json").read_text())["events"]
        # The original six Marks use the sold-sales basis; the twelve robinhood-testnet additions were
        # published on the saved-asks basis (labelled as asks, "not completed sales", in platform.html).
        # Every Mark's band must still equal its latest cached chain event.
        for c in certs:
            with self.subTest(cert=c["cert"]):
                self.assertEqual(c["price_basis"], "asks" if c.get("network") == "robinhood-testnet" else "psa10-sold")
                latest = max(events[c["cert"]], key=lambda e: e["t"])
                self.assertEqual([c[k] for k in ("low", "point", "high")],
                                 [latest[k] for k in ("low", "point", "high")])


if __name__ == "__main__":
    unittest.main()
