"""Build fuller Terms / Privacy / Risk pages in the existing legal style.
"""
import os, html
OUT = os.environ.get("OUT", "/home/user/workspace/site/public")
EFF = "3 October 2026"
CO = "Gacha Galaxy Labs Inc."
CO_FULL = "Gacha Galaxy Labs Inc., a company incorporated in Panama"
MAIL = '<a href="mailto:Support@gachagalaxy.io">Support@gachagalaxy.io</a>'
ATTR = ""
PAGES = {
"terms": ("Terms of Use", "These terms govern access to and use of Gacha Galaxy products, data, interfaces, and related services.", [
 ("Acceptance of Terms", f"By accessing or using gachagalaxy.io or any Gacha Galaxy service (the \"Service\"), you agree to these terms. The Service is operated by {CO_FULL} (\"Gacha Galaxy\", \"we\", \"us\"). If you use the Service on behalf of a company, you confirm you can accept these terms for it."),
 ("Platform Scope", "Gacha Galaxy provides price data infrastructure for graded collectible cards, including fair-value bands, confidence scores, the Mispricing Scanner and Gacha Mark certificates. Prices shown are asking prices and insured values from public marketplace listings, not completed sales. Site content is informational and does not constitute financial, investment, legal, or tax advice."),
 ("Eligibility", "You must be at least 18 years old, or the age of majority where you are based, to use the Service."),
 ("User Responsibilities", "You are responsible for your account activity, compliance with local laws, and any decisions made using information shown on the platform. Check any price, listing or certificate yourself before you buy, sell or rely on it."),
 ("Acceptable Use", "You agree not to: copy, scrape or resell our data in bulk without written permission; overload, probe or disrupt the Service; get around any access limits; misrepresent a Gacha Mark certificate or our data; or use the Service for anything unlawful, fraudulent or harmful."),
 ("Third-Party Data and Links", "Listings, images and prices come from third-party marketplaces and grading companies. We do not own them, control them or guarantee them. Links to other sites, including blockchain explorers, are for convenience only and are governed by those sites' own terms."),
 ("Gacha Mark Certificates", "A Gacha Mark records our price assessment for one graded card at a point in time. It is not a guarantee of value, authenticity, condition or future price, and it is not an offer to buy or sell. Gacha Mark is in pre-production and may change."),
 ("Intellectual Property", f"The Service, including its software, design, pricing methods, data compilations and the Gacha Galaxy and Gacha Mark names and marks, belongs to {CO} or its licensors. We grant you a limited, personal, revocable licence to view and use the Service as described in these terms. Card names, images and trademarks belong to their owners."),
 ("API and Data Access", "Access to our price API is for approved partners only and may be subject to a separate agreement. If you hold API access, keep your credentials private and follow any usage limits we set."),
 ("Changes to the Service", "We may add, change, suspend or remove any part of the Service at any time, including data sources and features."),
 ("Restricted Jurisdictions", "The service is not available in jurisdictions subject to OFAC sanctions or other restricted territories described in the Risk Disclosure."),
 ("No Warranty", "Data may be delayed, incomplete, or affected by third-party marketplace availability. Gacha Galaxy is provided on an as-is and as-available basis, without warranties of any kind, express or implied, including fitness for a particular purpose, accuracy and non-infringement."),
 ("Limitation of Liability", f"To the fullest extent permitted by law, {CO} and its team will not be liable for any indirect, incidental, special, consequential or punitive damages, or for any loss of profits, data, goodwill or trading losses, arising from your use of, or inability to use, the Service. Our total liability for any claim relating to the Service is limited to USD 100."),
 ("Indemnity", f"You agree to cover {CO} for any claims, losses and costs (including reasonable legal fees) that arise from your misuse of the Service or your breach of these terms."),
 ("Termination", "We may suspend or end your access to the Service at any time if we believe you have breached these terms or put the Service or other users at risk."),
 ("Governing Law and Disputes", "These terms are governed by the laws of Singapore. Any dispute will be handled by the courts of Singapore, unless the law where you are based gives you a right to bring it elsewhere."),
 ("Changes to These Terms", "We may update these terms from time to time. The date at the top shows when they last changed. If you keep using the Service after a change, you accept the updated terms."),
 ("Contact", f"Questions may be sent to {MAIL}."),
]),
"privacy": ("Privacy Policy", "This policy explains the categories of information Gacha Galaxy may process when users visit the site or use app features.", [
 ("Who We Are", f"gachagalaxy.io is operated by {CO_FULL}. We are responsible for the personal information described in this policy."),
 ("Information We Process", "The public website and platform do not require an account. When you visit, we and our hosting provider may process technical information such as your IP address, browser type, device, pages viewed and the time of your visit. If you email us, we process your name, email address and anything you choose to send. If you are an approved API partner, we process your contact details and usage of the API."),
 ("How We Use Information", "We use this information to run, secure and improve the Service; to prevent abuse and fraud; to answer your questions; and to meet legal obligations. We do not sell your personal information, and we do not use it for targeted advertising."),
 ("Legal Basis", "Where data protection laws such as the GDPR apply, we rely on our legitimate interests in running and securing the Service, on your consent where we ask for it, and on legal obligations where they apply."),
 ("Cookies and Similar Technology", "The public site does not set advertising or analytics cookies. Our hosting and security provider may use strictly necessary cookies or similar technology to protect the site from abuse."),
 ("Service Providers", "We use trusted providers to host and deliver the Service, including Cloudflare (hosting and security), GitHub (code and data updates) and Google Fonts (web fonts). They process information only to provide their services to us. Card images are loaded from the marketplaces that list them."),
 ("Blockchain Data", "Gacha Mark certificates are recorded on a public blockchain. Information written onchain is public and permanent, and we cannot change or delete it. We do not write personal information onchain."),
 ("International Transfers", "Our providers may process information outside your country. Where required, we rely on appropriate safeguards for these transfers."),
 ("Data Retention", "We keep personal information only as long as needed for the purposes above. Server logs are kept for a limited period for security. Emails are kept as long as needed to deal with your request."),
 ("Your Rights", f"Depending on where you are based, you may have the right to access, correct, delete or move your personal information, or to object to or limit how we use it. To make a request, email {MAIL}. You may also complain to your local data protection authority."),
 ("Security", "We use reasonable technical and organisational measures to protect information. No system is completely secure, so we cannot guarantee absolute security."),
 ("Children", "The Service is not intended for anyone under 18, and we do not knowingly collect information from children."),
 ("Changes to This Policy", "We may update this policy from time to time. The date at the top shows when it last changed."),
 ("Contact", f"Questions may be sent to {MAIL}."),
]),
"risk-disclosure": ("Risk Disclosure", "Gacha Galaxy products involve experimental software, third-party data, collectible-market volatility, and blockchain-related risks.", [
 ("Market Data Risk", "Collectible card prices can move quickly and marketplace data may be incomplete, delayed or wrong. Prices shown are asking prices and insured values from public listings, not completed sales, and may differ from what a card actually sells for."),
 ("Price Data Risk", "Fair-value bands, confidence scores and scanner gaps are estimates produced by our models. They depend on the listings available at the time and can be affected by errors, outliers or missing data. They are not a guarantee of value."),
 ("Third-Party Risk", "We rely on third-party marketplaces, grading companies, hosting providers and blockchain networks. Changes, outages or errors on their side can affect the Service."),
 ("Certificate Risk", "A Gacha Mark reflects our assessment at a point in time. It does not confirm authenticity, condition, ownership or future value. Gacha Mark is in pre-production, and the certificates shown are examples."),
 ("Blockchain and Smart Contract Risk", "Blockchain networks and smart contracts can have bugs, outages, forks or security issues. Onchain records are public and generally cannot be reversed."),
 ("Digital Asset Risk", "Digital assets, including any token associated with Gacha Galaxy, are highly volatile and may lose all of their value. Their legal and tax treatment is uncertain and may change. Nothing on this site is an offer or solicitation to buy or sell any asset."),
 ("Regulatory Risk", "Laws and regulations for collectibles, data and digital assets differ by country and may change. This may limit or end parts of the Service in some places."),
 ("Restricted Jurisdictions", "The Service is not offered to people or entities in jurisdictions subject to OFAC sanctions or other restricted territories, or where using it would be against local law. This includes, but is not limited to, Iran, North Korea, Cuba, Syria, the Crimea region of Russia, Belarus, Myanmar and Venezuela. Additional jurisdictions may be restricted based on local law."),
 ("No Advice", "Nothing on this site is financial, investment, legal or tax advice. Do your own research and get professional advice before making any decision."),
 ("Contact", f"Questions may be sent to {MAIL}."),
]),
}
TPL = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title} | Gacha Galaxy</title>
    <link rel="stylesheet" href="/legal/main.css">
</head>
<body>
    <main class="legal-shell">
        <a class="legal-brand" href="/">
            <img src="/legal/gg-logo.png" alt="Gacha Galaxy">
            <span>Gacha Galaxy</span>
        </a>
        <article class="legal-panel">
            <p class="section-label">[ Legal ]</p>
            <h1>{title}</h1>
            <p class="legal-intro">{intro}</p>
            <p class="legal-intro">Last updated: {eff}</p>
{sections}
            {attr}
        </article>
    </main>
</body>
</html>
"""
for slug, (title, intro, secs) in PAGES.items():
    body = "\n".join(f"                <section>\n                    <h2>{html.escape(h)}</h2>\n                    <p>{p}</p>\n                </section>" for h, p in secs)
    os.makedirs(f"{OUT}/{slug}", exist_ok=True)
    open(f"{OUT}/{slug}/index.html", "w", encoding="utf-8").write(TPL.format(title=title, intro=intro, eff=EFF, sections=body, attr=ATTR))
    print(slug, len(secs), "sections")
