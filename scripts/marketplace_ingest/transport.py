"""One documented, keyless GET only. No retries, auth, env reads or arbitrary URLs."""

import json
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .adapters import IngestError, MAX_BYTES, reject_secrets
from .registry import ADAPTERS


def plan_request(venue, *, limit=1, query=None, collection=None):
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20:
        raise IngestError("Request limit must be 1..20")
    if venue not in ADAPTERS:
        raise IngestError("No verified read contract for venue")
    if venue == "ebay":
        if not query or not isinstance(query, str) or len(query) > 200:
            raise IngestError("eBay planning requires a query of at most 200 characters")
        url = "https://api.ebay.com/buy/browse/v1/item_summary/search?" + urlencode({"q": query, "limit": limit})
        auth = "Application OAuth token (not read or handled by this CLI)"
    elif venue == "dyli":
        url = "https://www.dyli.io/api/public/v1/listings?" + urlencode({"page": 1, "pageSize": limit})
        auth = "x-api-key Read key (not read or handled by this CLI)"
    elif venue == "opensea":
        if not collection or not isinstance(collection, str) or len(collection) > 200:
            raise IngestError("OpenSea planning requires an explicit collection slug")
        url = "https://api.opensea.io/api/v2/listings/collection/" + quote(collection, safe="") + "/all?" + urlencode({"limit": limit})
        auth = "x-api-key (not read or created by this CLI)"
    else:
        url = "https://api.phygitals.com/api/marketplace/marketplace-listings?" + urlencode(
            {"page": 0, "itemsPerPage": limit, "listedStatus": "listed"})
        auth = "none per developer docs; permission/licensing conflict and observed 404 remain"
    return {"method": "GET", "url": url, "auth_requirement": auth, "max_requests": 1,
            "automatic_pagination": False, "automatic_retries": False, "is_live_feed": False}


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise IngestError("Redirect refused; no host/path fallback or access-control bypass")


def fetch_public(venue, *, permission_confirmed=False, limit=1, opener=None):
    if venue != "phygitals":
        raise IngestError("Only documented keyless Phygitals transport exists; key-gated venues are offline")
    if not permission_confirmed:
        raise IngestError("Resolve general terms/developer-doc conflict and confirm permission before network use")
    plan = plan_request(venue, limit=limit)
    request = Request(plan["url"], headers={"Accept": "application/json", "User-Agent": "GachaGalaxy-marketplace-ingest/0.1"}, method="GET")
    opener = opener or build_opener(NoRedirects())
    try:
        with opener.open(request, timeout=15) as response:
            if response.status != 200:
                raise IngestError(f"HTTP {response.status}; stopped without retry")
            if response.headers.get_content_type() != "application/json":
                raise IngestError("Non-JSON response; no browser challenge handling")
            data = response.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise IngestError("Response exceeds 2 MB bound")
            try:
                payload = json.loads(data)
                reject_secrets(payload)
                return payload, plan
            except (ValueError, UnicodeDecodeError) as exc:
                raise IngestError("Invalid JSON response") from exc
    except HTTPError as exc:
        raise IngestError(f"HTTP {exc.code}; stopped without retry or endpoint fallback") from None
    except (URLError, TimeoutError, OSError) as exc:
        raise IngestError(f"Public read failed ({type(exc).__name__}); stopped without retry") from None
