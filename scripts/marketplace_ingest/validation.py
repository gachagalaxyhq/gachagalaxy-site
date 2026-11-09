"""Bounded credential-free investigation; never saves response bodies or headers.

Only the explicitly sourced URLs below may be requested. This is not a
general URL fetcher and does not turn documentation or errors into live rows.
"""

from datetime import datetime, timezone
import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

from .adapters import IngestError, MAX_BYTES, normalize, reject_secrets
from .transport import NoRedirects

READS = {
    "phygitals-listings": (
        "https://api.phygitals.com/api/marketplace/marketplace-listings?page=0&itemsPerPage=1&listedStatus=listed",
        "https://phygitals.mintlify.app/public-api/index",
    ),
    "renaiss-contract": (
        "https://api.renaiss.xyz/v2/openapi.json",
        "https://docs.renaiss.xyz/api-reference",
    ),
    "renaiss-public-access": (
        "https://api.renaiss.xyz/v2/marketplace?limit=1&offset=0&listedOnly=true",
        "https://api.renaiss.xyz/v2/openapi.json",
    ),
}


def investigate(read, *, permission_confirmed=False, opener=None):
    """One GET, no retry/fallback; payload only in memory for caller inspection.

    Metadata is safe to retain. HTTP-error bodies and all headers are discarded.
    The caller must not persist a successful payload without a rights review.
    """
    if not permission_confirmed or read not in READS:
        raise IngestError("Explicit sanctioned-read acknowledgement and allowlisted read required")
    url, source = READS[read]
    observation = {
        "read": read, "url": url, "contract_source": source,
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "http_status": None, "outcome": "not_requested", "requests": 1,
        "live_listing_responses": 0, "live_listing_rows": 0,
        "body_retained": False, "is_live_feed": False,
    }
    request = Request(url, headers={"Accept": "application/json",
                                  "User-Agent": "GachaGalaxy-marketplace-validation/0.1"}, method="GET")
    opener = opener or build_opener(NoRedirects())
    try:
        with opener.open(request, timeout=20) as response:
            observation["http_status"] = response.status
            if response.status != 200:
                raise IngestError("Unexpected HTTP status")
            if response.headers.get_content_type() != "application/json":
                raise IngestError("Non-JSON response refused")
            data = response.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise IngestError("Response exceeds 2 MB bound")
            payload = json.loads(data)
            if read == "renaiss-contract":
                # OpenAPI defines names such as Authorization/accessToken. These
                # are schema properties, not response credentials. Do not apply
                # the listing-capture credential-name filter to public schemas.
                if (not isinstance(payload, dict) or not isinstance(payload.get("openapi"), str)
                        or not isinstance(payload.get("paths"), dict)):
                    raise IngestError("Expected official OpenAPI document")
            else:
                reject_secrets(payload)
            observation.update(outcome="json_received", response_bytes=len(data))
            return observation, payload
    except HTTPError as exc:
        observation.update(http_status=exc.code, outcome="http_error_no_retry")
        exc.close()
    except (URLError, TimeoutError, OSError):
        observation["outcome"] = "transport_error_no_retry"
    except (IngestError, ValueError, UnicodeDecodeError, RecursionError) as exc:
        observation["outcome"] = str(exc) if isinstance(exc, IngestError) else "invalid_json"
    return observation, None


def validate_payload(venue, payload, *, evidence_kind, source_url, observed_at,
                     rows_pointer=None):
    """Report normalization counts separately for live vs documented examples.

    Evidence kind is an operator assertion, not independent origin attestation.
    Do not output normalized records: they contain the source row in provenance.
    """
    if evidence_kind not in {"live_response", "documentation_example"}:
        raise IngestError("Evidence kind must distinguish live response from documentation example")
    result = normalize(venue, payload, source_url=source_url,
                       observed_at=observed_at, rows_pointer=rows_pointer)
    count = len(result["records"])
    return {"venue": venue, "evidence_kind": evidence_kind,
            "input_rows": result["input_rows"], "normalized_rows": count,
            "excluded_rows": result["excluded_fair_drop_rows"],
            "live_listing_responses": int(evidence_kind == "live_response"),
            "live_listing_rows": count if evidence_kind == "live_response" else 0,
            "documentation_example_rows": count if evidence_kind == "documentation_example" else 0,
            "is_live_feed": False}
