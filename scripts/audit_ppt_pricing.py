"""Read-only diagnostics for cached PPT data; never computes a replacement value.

Run: python scripts/audit_ppt_pricing.py /tmp/opencode --as-of 2026-11-06T12:00:00Z
Thresholds are local audit policy, not provider guarantees or borrowing criteria.
"""
import argparse
import datetime as dt
import json
import math
from pathlib import Path


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo is not None else None
    except (AttributeError, TypeError, ValueError):
        return None


def assess_grade(grade, *, as_of, stale_days=7, min_sales=3):
    """Keep lifetime count, recent volume, sale age and computation age separate."""
    now = timestamp(as_of)
    if now is None:
        raise ValueError("as_of must be an explicit timezone-aware ISO timestamp")
    g = grade if isinstance(grade, dict) else {}
    smart = g.get("smartMarketPrice") or {}
    flags = []
    count = g.get("count")
    if not number(count) or count < 0 or int(count) != count:
        flags.append("missing_or_invalid_sales_count")
    elif count == 0:
        flags.append("no_sales")
    elif count < min_sales:
        flags.append("small_total_sample")
    # A provider smart price is not evidence of a sale when count is zero/missing.
    if not any(number(g.get(k)) and g[k] > 0 for k in ("medianPrice", "marketPriceMedian7Day")):
        flags.append("missing_sold_median")
    volume = g.get("dailyVolume7Day")
    recent = volume * 7 if number(volume) and volume >= 0 else None
    if recent is None:
        flags.append("unknown_recent_sample")
    elif recent < min_sales - 1e-9:
        flags.append("small_recent_sample")
    ages = {}
    for field, label in (("lastSaleDate", "sale"), ("lastMarketUpdate", "market_update")):
        t = timestamp(g.get(field))
        age = (now - t).total_seconds() / 86400 if t else None
        ages[label] = age
        if age is None:
            flags.append("missing_" + label + "_time")
        elif age < 0:
            flags.append("future_" + label + "_time")
        elif age > stale_days:
            flags.append("stale_" + label)
    sources = g.get("salesBySource")
    if not isinstance(sources, dict) or not sources:
        flags.append("unknown_sales_sources")
    elif any(k != "ebay" and number(v) and v > 0 for k, v in sources.items()):
        flags.append("not_ebay_only")
    if smart.get("confidence") == "low":
        flags.append("provider_low_confidence")
    if smart and (smart.get("daysUsed") != 7 or smart.get("method") != "7day_filtered_weighted"):
        flags.append("not_seven_day_smart_method")
    return {"flags": flags, "total_sales": count, "reported_seven_day_volume": recent,
            "age_days": ages, "provider_method": smart.get("method"),
            "provider_window_days": smart.get("daysUsed"), "sales_sources": sources}


def audit_cache(directory, as_of):
    directory = Path(directory)
    sample = json.loads((directory / "ppt_sample.json").read_text())
    ebay = json.loads((directory / "ppt_ebay.json").read_text())
    multi = json.loads((directory / "ppt_multi.json").read_text())
    rows = []
    for c in ebay["data"]:
        rows.append({"cache": "ppt_ebay.json", "id": c["id"], "name": c["name"],
                     "number": c["cardNumber"], **assess_grade(
                         (c.get("ebay") or {}).get("salesByGrade", {}).get("psa10"), as_of=as_of)})
    for cert, c in multi.items():
        rows.append({"cache": "ppt_multi.json", "cert": cert, "name": c["name"],
                     **assess_grade(c.get("g"), as_of=as_of)})
    return {"as_of": as_of, "policy": {"stale_after_days": 7, "small_sample_below": 3},
            "note": "Cached evidence only. Reported volume is dailyVolume7Day * 7, not a verified filtered comp count. No valuations generated.",
            "sample_rows": len(sample),
            "sample_zero_sales": sum(c.get("psa10_sales") == 0 for c in sample),
            "sample_missing_median": sum(c.get("median") is None for c in sample), "grades": rows}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache_directory")
    parser.add_argument("--as-of", required=True)
    args = parser.parse_args()
    print(json.dumps(audit_cache(args.cache_directory, args.as_of), indent=2, allow_nan=False))
