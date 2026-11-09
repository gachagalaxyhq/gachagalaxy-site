"""Pure standard-library schema adapters. No title parsing, matching or HTTP."""

from copy import deepcopy
from datetime import datetime
from decimal import Decimal, InvalidOperation, localcontext
import hashlib
import json
from urllib.parse import urlsplit

from .registry import ADAPTERS

MAX_ROWS = 200
MAX_BYTES = 2_000_000


class IngestError(ValueError):
    """Rejected input, unsupported venue, or schema drift."""


def scalar(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise IngestError("Expected a scalar string/number or null")
    return str(value)


def money(value, decimals=0):
    if value is None:
        return None
    if isinstance(decimals, bool) or not isinstance(decimals, int) or not 0 <= decimals <= 36:
        raise IngestError("Money decimals must be an integer from 0 to 36")
    try:
        with localcontext() as ctx:
            ctx.prec = 100
            number = Decimal(scalar(value))
            if (not number.is_finite() or number < 0 or number.adjusted() > 60
                    or number.as_tuple().exponent < -60 or len(number.as_tuple().digits) > 100):
                raise IngestError("Invalid nonnegative finite money value")
            result = number / (Decimal(10) ** decimals)
            return format(result, "f")
    except (InvalidOperation, TypeError) as exc:
        raise IngestError("Invalid money value") from exc


def public_url(value):
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise IngestError("URL must be a string")
    try:
        url = urlsplit(value)
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or url.fragment or url.query or url.port not in (None, 443)):
            raise IngestError("Only credential-free HTTPS URLs without query/fragment are accepted")
    except ValueError as exc:
        raise IngestError("Invalid URL") from exc
    return value


def display_url(value):
    """Keep public display links (including tracking/image queries), never fetch them."""
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise IngestError("Display URL must be a string")
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
            raise IngestError("Unsafe display URL")
    except ValueError as exc:
        raise IngestError("Invalid display URL") from exc
    return value


def utc_timestamp(value):
    if not isinstance(value, str):
        raise IngestError("observed_at must be an explicit timezone-aware ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.utcoffset() is None:
            raise ValueError("no timezone")
    except ValueError as exc:
        raise IngestError("observed_at must be an explicit timezone-aware ISO timestamp") from exc
    return value


def reject_secrets(value):
    """Reject credential-bearing captures instead of copying them into provenance."""
    forbidden = {"authorization", "cookie", "setcookie", "apikey", "xapikey", "accesstoken",
                 "refreshtoken", "privatekey", "password", "clientsecret"}
    stack = [(value, 0)]
    while stack:
        obj, depth = stack.pop()
        if depth > 40:
            raise IngestError("Input nesting exceeds bound")
        if isinstance(obj, dict):
            for key, val in obj.items():
                compact = str(key).lower().replace("_", "").replace("-", "")
                if compact in forbidden:
                    raise IngestError("Credential/header-bearing input is not accepted")
                stack.append((val, depth + 1))
        elif isinstance(obj, list):
            stack.extend((item, depth + 1) for item in obj)


def pointer_rows(payload, pointer):
    obj = payload
    if pointer:
        if not pointer.startswith("/"):
            raise IngestError("rows_pointer must be an RFC 6901 pointer")
        for key in pointer[1:].split("/"):
            key = key.replace("~1", "/").replace("~0", "~")
            if not isinstance(obj, dict) or key not in obj:
                raise IngestError("rows_pointer not found")
            obj = obj[key]
    if not isinstance(obj, list) or any(not isinstance(row, dict) for row in obj):
        raise IngestError("Expected a row array; explicitly supply --rows-pointer for an envelope")
    if len(obj) > MAX_ROWS:
        raise IngestError("Page exceeds 200-row bound; no silent truncation")
    return obj


def traits(rows, key_field, value_field):
    if rows is None:
        return {}
    if not isinstance(rows, list):
        raise IngestError("Trait container must be an array")
    out = {}
    for trait in rows:
        if not isinstance(trait, dict) or not isinstance(trait.get(key_field), str):
            raise IngestError("Malformed trait")
        key = trait[key_field].casefold()
        value = scalar(trait.get(value_field))
        if key in out and out[key] != value:
            raise IngestError("Conflicting duplicate trait; cannot infer certainty")
        out[key] = value
    return out


def first(mapping, *keys):
    for key in keys:
        value = mapping.get(key)
        if value is not None and value != "":
            return value
    return None


def object_field(row, key):
    val = row.get(key, {})
    if not isinstance(val, dict):
        raise IngestError(f"{key} must be an object")
    return val


def normalize_row(venue, row):
    result = {key: None for key in (
        "source_id", "cert", "grader", "grade", "name", "set", "number", "language",
        "ask", "currency", "source_timestamp", "listing_url", "image_url")}
    warnings = []
    if venue == "ebay":
        result.update(source_id=scalar(row.get("itemId")), name=scalar(row.get("title")),
                      listing_url=display_url(row.get("itemWebUrl")),
                      image_url=display_url(object_field(row, "image").get("imageUrl")),
                      source_timestamp=scalar(row.get("itemCreationDate")))
        price = object_field(row, "price")
        # A current auction bid is not an ask. Search's price alone is insufficient.
        options = row.get("buyingOptions", [])
        if not isinstance(options, list):
            raise IngestError("buyingOptions must be an array")
        if "FIXED_PRICE" in options:
            result.update(ask=money(price.get("value")), currency=scalar(price.get("currency")))
        elif price:
            warnings.append("Price not promoted to ask without FIXED_PRICE buying option")
        t = traits(row.get("localizedAspects"), "name", "value")
        for field, names in {
            "cert": ("certification number",), "grader": ("professional grader",),
            "grade": ("grade",), "set": ("set",), "number": ("card number",),
            "language": ("language",),
        }.items():
            result[field] = first(t, *names)
    elif venue == "dyli":
        # These are distinct IDs: never fall back from listing_id to token/product/cert.
        result.update(source_id=scalar(row.get("listing_id")), cert=scalar(row.get("cert")),
                      name=scalar(row.get("name")), ask=money(row.get("price")),
                      currency=scalar(row.get("currency")),
                      source_timestamp=scalar(row.get("updated_at")),
                      listing_url=display_url(first(row, "url", "dyli_url", "marketplace_url")),
                      image_url=display_url(row.get("image_url")))
        # Grader/grade/set/language need documented enrichment; do not parse the title.
        warnings.append("DYLI listing-only capture: grading and card traits need authorized metadata/cert enrichment")
    elif venue == "phygitals":
        result.update(source_id=scalar(row.get("address")), name=scalar(row.get("name")),
                      image_url=display_url(row.get("image")))
        if row.get("listed") is True and row.get("price") is not None:
            result.update(ask=money(row["price"], 6), currency="USDC")
        # Documented /card/:slug route, not a guessed API. Do not use address as slug.
        slug = row.get("slug")
        if slug:
            from urllib.parse import quote
            if not isinstance(slug, str):
                raise IngestError("slug must be a string")
            result["listing_url"] = "https://www.phygitals.com/card/" + quote(slug, safe="")
        t = traits(row.get("metadata"), "key", "value")
        for field, names in {
            "cert": ("cert number", "certification number"), "grader": ("grader",),
            "grade": ("grade",), "set": ("set",), "number": ("card number",),
            "language": ("language",),
        }.items():
            result[field] = first(t, *names)
        activity = row.get("mostRecentListActivity")
        if activity is not None:
            if not isinstance(activity, dict):
                raise IngestError("mostRecentListActivity must be an object or null")
            if activity.get("time") is not None:
                result["source_timestamp"] = utc_timestamp(activity["time"])
        if result["source_timestamp"] is None:
            warnings.append("Phygitals listing activity time absent; source_timestamp left null")
    else:  # OpenSea listing schema, not token metadata or physical authentication.
        result["source_id"] = scalar(row.get("order_hash"))
        price = object_field(object_field(row, "price"), "current")
        if price.get("value") is not None:
            if "decimals" not in price:
                raise IngestError("OpenSea price.decimals missing; will not guess currency scale")
            result.update(ask=money(price["value"], price["decimals"]),
                          currency=scalar(price.get("currency")))
        warnings.append("OpenSea listing/order only: no metadata join; token IDs are not slab certificates")
    if not result["source_id"]:
        raise IngestError(f"{venue}: required source listing ID missing")
    if result["ask"] is not None and not result["currency"]:
        raise IngestError("Ask amount without explicit currency is not accepted")
    return result, warnings


def normalize(venue, payload, *, source_url, observed_at, rows_pointer=None):
    if venue not in ADAPTERS:
        raise IngestError(f"{venue}: no verified permitted schema adapter; inspect status")
    public_url(source_url)
    utc_timestamp(observed_at)
    reject_secrets(payload)
    try:
        encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()
    except (ValueError, TypeError, RecursionError) as exc:
        raise IngestError("Input must be finite JSON") from exc
    if len(encoded) > MAX_BYTES:
        raise IngestError("Input exceeds 2 MB bound")
    # Restrict provenance to the documented venue host, not a claim of verified origin.
    hosts = {"ebay": "api.ebay.com", "dyli": "www.dyli.io",
             "phygitals": "api.phygitals.com", "opensea": "api.opensea.io"}
    if urlsplit(source_url).hostname != hosts[venue]:
        raise IngestError("source_url must use the documented API host")
    if rows_pointer is None:
        # Phygitals' official Markdown response documents this exact envelope.
        # Preserve explicit bare-array captures without guessing other wrappers.
        rows_pointer = {"ebay": "/itemSummaries", "opensea": "/listings"}.get(venue, "")
        if venue == "phygitals" and isinstance(payload, dict):
            rows_pointer = "/listings"
    rows = pointer_rows(payload, rows_pointer)
    digest = hashlib.sha256(encoded).hexdigest()
    records = []
    seen = set()
    skipped = 0
    for index, row in enumerate(rows):
        if venue == "dyli" and row.get("is_fair_drop") is True:
            skipped += 1
            continue
        record, warnings = normalize_row(venue, row)
        if record["source_id"] in seen:
            raise IngestError("Duplicate listing ID in page; not silently merged")
        seen.add(record["source_id"])
        record.update(venue=venue, observed_at=observed_at,
                      verification="source_reported_unverified", warnings=warnings,
                      provenance={"source_url": source_url, "row_pointer": f"{rows_pointer}/{index}",
                                  "payload_sha256": digest, "raw": deepcopy(row)})
        records.append(record)
    return {"schema_version": 1, "mode": "capture_normalization_not_live_feed", "venue": venue,
            "input_rows": len(rows), "excluded_fair_drop_rows": skipped, "records": records}
