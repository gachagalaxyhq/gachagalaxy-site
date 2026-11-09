"""Offline diagnostics tests; synthetic edge cases are not live market data."""
import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("audit_ppt_pricing", ROOT / "scripts/audit_ppt_pricing.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
AS_OF = "2026-11-06T12:00:00Z"


class PricingAuditTests(unittest.TestCase):
    def flags(self, g):
        return audit.assess_grade(g, as_of=AS_OF)["flags"]

    def test_missing_does_not_become_zero_dollar_valuation(self):
        result = audit.assess_grade(None, as_of=AS_OF)
        self.assertIn("missing_sold_median", result["flags"])
        self.assertNotIn("price", result)

    def test_zero_sales_with_provider_price_is_still_no_sales(self):
        self.assertIn("no_sales", self.flags({"count": 0, "smartMarketPrice": {"price": 100}}))

    def test_recent_update_does_not_refresh_old_sale(self):
        flags = self.flags({"count": 1, "lastSaleDate": "2026-08-31T00:00:00Z",
                            "lastMarketUpdate": "2026-11-06T11:00:00Z"})
        self.assertIn("stale_sale", flags)
        self.assertNotIn("stale_market_update", flags)
        self.assertIn("small_total_sample", flags)

    def test_lifetime_count_does_not_hide_one_recent_sale(self):
        self.assertIn("small_recent_sample", self.flags({"count": 762, "dailyVolume7Day": 1 / 7}))

    def test_invalid_and_future_times_are_not_fresh(self):
        flags = self.flags({"lastSaleDate": "bad", "lastMarketUpdate": "2026-11-07T00:00:00Z"})
        self.assertIn("missing_sale_time", flags)
        self.assertIn("future_market_update_time", flags)

    def test_asking_fields_are_not_used_as_sold_medians(self):
        self.assertIn("missing_sold_median", self.flags({"market": 200, "low": 100, "listings": 20}))

    def test_window_and_sources_are_not_relabelled(self):
        flags = self.flags({"salesBySource": {"ebay": 642, "fanatics": 120},
                            "smartMarketPrice": {"daysUsed": 14, "method": "14day_filtered_weighted"}})
        self.assertIn("not_ebay_only", flags)
        self.assertIn("not_seven_day_smart_method", flags)

    def test_three_sale_threshold_tolerates_float_roundoff(self):
        self.assertNotIn("small_recent_sample", self.flags({"dailyVolume7Day": 3 / 7}))

    def test_invalid_numbers_are_not_counts(self):
        for n in [True, "3", -1, 1.5, float("nan")]:
            self.assertIn("missing_or_invalid_sales_count", self.flags({"count": n}))

    def test_input_is_not_mutated(self):
        g = {"count": 1, "salesBySource": {"ebay": 1}}
        original = copy.deepcopy(g)
        self.flags(g)
        self.assertEqual(g, original)

    def test_timezone_is_required(self):
        with self.assertRaises(ValueError):
            audit.assess_grade({}, as_of="2026-11-06")

    @unittest.skipUnless(Path("/tmp/opencode/ppt_multi.json").exists(), "external real cache not present")
    def test_real_caches_expose_missing_thin_and_mixed_evidence(self):
        result = audit.audit_cache("/tmp/opencode", AS_OF)
        self.assertEqual((result["sample_rows"], result["sample_zero_sales"], result["sample_missing_median"]),
                         (453, 345, 345))
        row = next(r for r in result["grades"] if r.get("cert") == "153708045")
        self.assertAlmostEqual(row["reported_seven_day_volume"], 1)
        self.assertTrue({"small_recent_sample", "not_ebay_only", "not_seven_day_smart_method"} <= set(row["flags"]))
        self.assertTrue(any("stale_sale" in r["flags"] and "small_total_sample" in r["flags"]
                            for r in result["grades"]))


if __name__ == "__main__":
    unittest.main()
