"""Research state as of 2026-11-08; unknown does not mean unavailable."""

VENUES = {
    "ebay": {
        "domain": "https://www.ebay.com",
        "status": "offline_adapter_key_required",
        "auth": "Browse Application OAuth token; no credentials read by this tool",
        "access": "Developer registration is free; production eligibility and API license apply. No API calls made.",
        "license": "API license limits use to facilitating eBay services, intermediate copies and compliant display; not an open dataset license.",
        "evidence": [
            "https://developer.ebay.com/",
            "https://developer.ebay.com/api-docs/buy/static/api-browse.html",
            "https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search",
            "https://developer.ebay.com/join/api-license-agreement",
        ],
    },
    "courtyard": {
        "domain": "https://courtyard.io",
        "status": "permission_required_no_verified_read_contract",
        "auth": "No sanctioned listing API contract verified; key and free-tier requirements unknown",
        "access": "Official docs establish domain; public home fetch was a shell, not proof of API unavailability.",
        "license": "Terms sections 11 and 14 restrict commercial reuse and unauthorized automated extraction. No scraper implemented.",
        "evidence": [
            "https://docs.courtyard.io/courtyard",
            "https://docs.courtyard.io/courtyard/logistics-and-legal/user-agreements/terms-of-service",
        ],
    },
    "phygitals": {
        "domain": "https://www.phygitals.com",
        "status": "documented_adapter_transport_unresolved_permission_review",
        "auth": "Official developer index says marketplace browse requires no key",
        "access": "One crawler attempt failed; one direct one-row GET at documented api.phygitals.com returned HTTP 404. No alternative host/path probes.",
        "license": "Developer listing docs invite price-comparison tooling; general terms sections 9/10 restrict automation and content reuse without consent. Resolve conflict before recurring/commercial use.",
        "evidence": [
            "https://www.phygitals.com/docs/public-api",
            "https://phygitals.mintlify.app/public-api/index",
            "https://phygitals.mintlify.app/public-api/marketplace/listings",
            "https://phygitals.mintlify.app/public-api/marketplace/filters",
            "https://docs.phygitals.com/user-agreements/terms-of-service",
        ],
    },
    "beezie": {
        "domain": "https://beezie.com",
        "status": "permission_required_no_verified_read_contract",
        "auth": "No sanctioned listing API contract verified; key and free-tier requirements unknown",
        "access": "Public marketplace and official docs identified; no listing API validation performed.",
        "license": "Official linked terms prohibit automatic monitoring/copying and restrict content reuse. Terms text still names beezie.io; confirm applicability with venue. No scraper implemented.",
        "evidence": [
            "https://beezie.com/",
            "https://docs.beezie.com/",
            "https://docs.beezie.com/our-offerings/marketplace",
            "https://docs.beezie.com/information/terms-of-use",
        ],
    },
    "renaiss": {
        "domain": "https://www.renaiss.xyz",
        "status": "permission_required_no_verified_read_contract",
        "auth": "No sanctioned listing API contract verified; key and free-tier requirements unknown",
        "access": "Official terms identify renaiss.xyz. renaiss.art was not used. No marketplace probing.",
        "license": "Terms 4.2 personal-use license; 4.6 prohibits automated extraction without permission and competing-service use.",
        "evidence": ["https://www.renaiss.xyz/terms"],
    },
    "dyli": {
        "domain": "https://www.dyli.io",
        "status": "offline_adapter_free_read_key_required",
        "auth": "Account-linked Read key in x-api-key; this tool never reads keys",
        "access": "Official docs say Read API is free; account, linked email and key required. Commerce is separate and paid. No API calls made.",
        "license": "Docs explicitly support catalog/search tools. No open redistribution/image license established; confirm retention, attribution and image rights before publication.",
        "evidence": [
            "https://www.dyli.io/",
            "https://www.dyli.io/docs/llms/read-api.md",
            "https://www.dyli.io/docs/api/listings",
            "https://www.dyli.io/docs/api/authentication",
            "https://www.dyli.io/docs/getting-started/request-access",
        ],
    },
    "opensea": {
        "domain": "https://opensea.io",
        "status": "offline_adapter_key_required",
        "auth": "x-api-key required for all REST reads; no key accessed or created",
        "access": "Free-tier keys documented. Issuance is POST, so not executed under no-remote-writes constraint.",
        "license": "Official overview requests OpenSea linkbacks and logo attribution. API access is not an image/content redistribution license; review full terms before publishing.",
        "evidence": [
            "https://docs.opensea.io/reference/api-overview",
            "https://docs.opensea.io/reference/api-keys",
            "https://docs.opensea.io/reference/list_listings_collection_all",
            "https://docs.opensea.io/docs/opensea-fees",
            "https://github.com/ProjectOpenSea/opensea-cli",
        ],
    },
}

ADAPTERS = frozenset({"ebay", "phygitals", "dyli", "opensea"})
