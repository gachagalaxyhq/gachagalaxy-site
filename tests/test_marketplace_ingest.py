"""Synthetic schema fixtures only. Tests never contact marketplaces."""

import copy
from email.message import Message
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from urllib.error import HTTPError
from unittest.mock import Mock, mock_open, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from marketplace_ingest.adapters import IngestError, normalize, money
from marketplace_ingest.registry import VENUES
from marketplace_ingest.transport import fetch_public, plan_request, NoRedirects
from marketplace_ingest.__main__ import main


OBSERVED = "2026-11-08T00:00:00Z"
HOSTS = {"ebay": "https://api.ebay.com/buy/browse/v1/item_summary/search",
         "dyli": "https://www.dyli.io/api/public/v1/listings",
         "phygitals": "https://api.phygitals.com/api/marketplace/marketplace-listings",
         "opensea": "https://api.opensea.io/api/v2/listings/collection/example/all"}


def run(venue, payload, **kwargs):
    return normalize(venue, payload, source_url=HOSTS[venue], observed_at=OBSERVED, **kwargs)


class AdapterTests(unittest.TestCase):
    def test_ebay_fixed_price_and_explicit_aspects(self):
        row = {"itemId": "fixture-listing", "title": "Fixture card PSA 10 cert 999",
               "price": {"value": "19.99", "currency": "USD"}, "buyingOptions": ["FIXED_PRICE"],
               "localizedAspects": [{"name": "Certification Number", "value": "0000123"},
                                    {"name": "Professional Grader", "value": "PSA"},
                                    {"name": "Grade", "value": "9"}],
               "image": {"imageUrl": "https://example.org/fixture.jpg"}}
        result = run("ebay", {"itemSummaries": [row]})["records"][0]
        self.assertEqual((result["ask"], result["cert"], result["grade"]), ("19.99", "0000123", "9"))
        self.assertEqual(result["provenance"]["raw"], row)
        result["provenance"]["raw"]["title"] = "changed"
        self.assertNotEqual(row["title"], "changed")

    def test_auction_bid_is_not_ask(self):
        result = run("ebay", {"itemSummaries": [{"itemId": "a", "buyingOptions": ["AUCTION"],
                     "price": {"value": "1", "currency": "USD"}}]})["records"][0]
        self.assertIsNone(result["ask"])

    def test_no_cert_or_grading_inference_from_title_id_or_image(self):
        for venue, payload in [
            ("ebay", {"itemSummaries": [{"itemId": "123", "title": "PSA 10 cert 999"}]}),
            ("dyli", [{"listing_id": "123", "name": "PSA 10 cert 999", "token_id": "999"}]),
            ("phygitals", [{"address": "123", "name": "PSA 10 cert 999", "image": "https://example.org/999.jpg"}]),
            ("opensea", {"listings": [{"order_hash": "123"}]}),
        ]:
            with self.subTest(venue=venue):
                row = run(venue, payload)["records"][0]
                for key in ("cert", "grader", "grade"):
                    self.assertIsNone(row[key])
                self.assertEqual(row["verification"], "source_reported_unverified")

    def test_dyli_fields_and_fair_drop_exclusion(self):
        rows = [{"listing_id": "a", "product_id": "b", "token_id": "c", "cert": "001",
                 "name": "Fixture", "price": 0, "currency": "USD", "updated_at": OBSERVED,
                 "url": "https://www.dyli.io/drop/fixture"},
                {"listing_id": "entry", "is_fair_drop": True, "price": 1}]
        result = run("dyli", {"captured_rows": rows}, rows_pointer="/captured_rows")
        self.assertEqual(result["excluded_fair_drop_rows"], 1)
        self.assertEqual(result["records"][0]["ask"], "0")
        self.assertEqual(result["records"][0]["source_id"], "a")
        self.assertEqual(result["records"][0]["source_timestamp"], OBSERVED)

    def test_phygitals_scale_and_traits(self):
        row = {"address": "mint-fixture", "listed": True, "price": "12345678", "slug": "fixture",
               "metadata": [{"key": "Grader", "value": "CGC"}, {"key": "Grade", "value": "10"},
                            {"key": "Cert Number", "value": "00098"}, {"key": "Set", "value": "Example"},
                            {"key": "Card Number", "value": "001"}, {"key": "Language", "value": "English"}]}
        record = run("phygitals", [row])["records"][0]
        self.assertEqual((record["ask"], record["currency"]), ("12.345678", "USDC"))
        self.assertEqual(record["cert"], "00098")
        self.assertEqual(record["number"], "001")
        self.assertIsNone(record["source_timestamp"])
        self.assertEqual(record["listing_url"], "https://www.phygitals.com/card/fixture")

    def test_phygitals_unlisted_and_fmv_not_asks(self):
        row = run("phygitals", [{"address": "a", "listed": False, "price": "1000000", "altFmv": 400}])["records"][0]
        self.assertIsNone(row["ask"])

    def test_opensea_decimal_scale_and_no_metadata_join(self):
        payload = {"listings": [{"order_hash": "fixture", "price": {"current": {
            "currency": "ETH", "decimals": 18, "value": "7000000000000000001"}}}]}
        row = run("opensea", payload)["records"][0]
        self.assertEqual(row["ask"], "7.000000000000000001")
        self.assertIsNone(row["listing_url"])
        del payload["listings"][0]["price"]["current"]["decimals"]
        with self.assertRaises(IngestError):
            run("opensea", payload)

    def test_missing_currency_rejected(self):
        with self.assertRaises(IngestError):
            run("dyli", [{"listing_id": "a", "price": "10"}])

    def test_missing_id_not_replaced_by_cert_or_product(self):
        with self.assertRaises(IngestError):
            run("dyli", [{"product_id": "a", "cert": "b"}])

    def test_money_bounds(self):
        for value in ("NaN", "Infinity", "-1", True, {}, "1e100000", "1e-1000000"):
            with self.subTest(value=value), self.assertRaises(IngestError):
                money(value)
        for decimals in (-1, 37, "6", True):
            with self.assertRaises(IngestError):
                money("1", decimals)

    def test_unsupported_venues_fail_closed(self):
        for venue in ("courtyard", "beezie", "renaiss"):
            with self.assertRaises(IngestError):
                normalize(venue, [], source_url="https://example.org", observed_at=OBSERVED)
            with self.assertRaises(IngestError):
                plan_request(venue)

    def test_schema_drift_and_error_envelopes_not_empty_success(self):
        for payload in ({"error": "Unauthorized"}, {"listings": []}, {"items": [None]}):
            with self.assertRaises(IngestError):
                run("dyli", payload)
        self.assertEqual(run("dyli", [])["records"], [])

    def test_duplicate_ids_and_conflicting_traits(self):
        with self.assertRaises(IngestError):
            run("dyli", [{"listing_id": "a"}] * 2)
        with self.assertRaises(IngestError):
            run("phygitals", [{"address": "a", "metadata": [
                {"key": "Grade", "value": "9"}, {"key": "grade", "value": "10"}]}])

    def test_capture_provenance_is_stable_and_not_input_mutation(self):
        data = [{"listing_id": "a"}]
        original = copy.deepcopy(data)
        a = run("dyli", data)["records"][0]
        b = run("dyli", data)["records"][0]
        self.assertEqual(a["provenance"]["payload_sha256"], b["provenance"]["payload_sha256"])
        self.assertEqual(data, original)
        self.assertEqual(a["provenance"]["row_pointer"], "/0")

    def test_bounded_input_and_timezone(self):
        with self.assertRaises(IngestError):
            run("dyli", [{"listing_id": str(n)} for n in range(201)])
        with self.assertRaises(IngestError):
            run("dyli", [{"listing_id": "a", "name": "x" * 2_000_001}])
        with self.assertRaises(IngestError):
            normalize("dyli", [], source_url=HOSTS["dyli"], observed_at="2026-11-08")

    def test_no_credentials_in_provenance_or_unsafe_urls(self):
        for field in ("authorization", "x-api-key", "access_token", "password", "cookie", "set-cookie"):
            with self.assertRaises(IngestError):
                run("dyli", [{"listing_id": "a", field: "fixture-not-secret"}])
        for url in ("https://www.dyli.io/api?apiKey=fixture", "http://www.dyli.io/api",
                    "https://user:fixture@www.dyli.io/api", "https://evil.example/api"):
            with self.assertRaises(IngestError):
                normalize("dyli", [], source_url=url, observed_at=OBSERVED)
        with self.assertRaises(IngestError):
            run("dyli", [{"listing_id": "a", "url": "javascript:alert(1)"}])


class TransportTests(unittest.TestCase):
    def test_request_plans_are_bounded_get_only(self):
        for venue, kwargs in (("ebay", {"query": "fixture & card"}), ("dyli", {}),
                              ("phygitals", {}), ("opensea", {"collection": "fixture/slug"})):
            plan = plan_request(venue, **kwargs)
            self.assertEqual(plan["method"], "GET")
            self.assertFalse(plan["automatic_pagination"])
            self.assertFalse(plan["is_live_feed"])
            self.assertEqual(plan["max_requests"], 1)
        for limit in (0, 21, True):
            with self.assertRaises(IngestError):
                plan_request("dyli", limit=limit)

    def test_permission_and_keyed_venues_never_open(self):
        opener = Mock()
        for venue in VENUES:
            with self.assertRaises(IngestError):
                fetch_public(venue, opener=opener)
        opener.open.assert_not_called()

    def test_single_get_json_no_auth(self):
        headers = Message()
        headers["Content-Type"] = "application/json"
        response = Mock(status=200, headers=headers)
        response.read.return_value = b'{"fixture": []}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = response
        payload, plan = fetch_public("phygitals", permission_confirmed=True, opener=opener)
        self.assertEqual(payload, {"fixture": []})
        opener.open.assert_called_once()
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertNotIn("Authorization", request.headers)
        self.assertNotIn("Cookie", request.headers)

    def test_http_errors_no_retry(self):
        for code in (401, 403, 404, 429, 503):
            opener = Mock()
            opener.open.side_effect = HTTPError(HOSTS["phygitals"], code, "fixture", {}, None)
            with self.assertRaisesRegex(IngestError, str(code)):
                fetch_public("phygitals", permission_confirmed=True, opener=opener)
            opener.open.assert_called_once()

    def test_redirect_refused(self):
        with self.assertRaises(IngestError):
            NoRedirects().redirect_request(None, None, 302, "fixture", {}, "https://example.org")

    def test_html_and_oversize_responses_fail(self):
        for mime, body in (("text/html", b"challenge"), ("application/json", b"x" * 2_000_001),
                           ("application/json", b"invalid")):
            headers = Message()
            headers["Content-Type"] = mime
            response = Mock(status=200, headers=headers)
            response.read.return_value = body
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            opener = Mock()
            opener.open.return_value = response
            with self.assertRaises(IngestError):
                fetch_public("phygitals", permission_confirmed=True, opener=opener)

    def test_cli_status_and_plan_smoke(self):
        root = Path(__file__).resolve().parents[1]
        for args in (("status",), ("plan", "dyli")):
            result = subprocess.run([sys.executable, "-B", "-m", "scripts.marketplace_ingest", *args],
                                    cwd=root, capture_output=True, text=True, check=True)
            self.assertFalse(json.loads(result.stdout)["is_live_feed"])

    def test_cli_normalize_capture_and_failure_exit(self):
        data = b'[{"listing_id":"fixture","cert":"0001","price":"1.25","currency":"USD"}]'
        argv = ["normalize", "dyli", "--input", "fixture.json", "--source-url", HOSTS["dyli"],
                "--observed-at", OBSERVED]
        output = io.StringIO()
        with patch("pathlib.Path.is_symlink", return_value=False), \
             patch("pathlib.Path.is_file", return_value=True), \
             patch("pathlib.Path.stat", return_value=Mock(st_size=len(data))), \
             patch("pathlib.Path.open", mock_open(read_data=data)), patch("sys.stdout", output):
            self.assertEqual(main(argv), 0)
        record = json.loads(output.getvalue())["records"][0]
        self.assertEqual(record["cert"], "0001")
        self.assertEqual(record["ask"], "1.25")
        errors = io.StringIO()
        with patch("sys.stderr", errors):
            self.assertEqual(main(["fetch-public", "phygitals"]), 2)
        self.assertIn("permission", json.loads(errors.getvalue())["error"])


if __name__ == "__main__":
    unittest.main()
