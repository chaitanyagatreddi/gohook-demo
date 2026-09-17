"""
Reddit Presence Score.

The searches showed what actually separates brands on Reddit, and it isn't
volume. Postiz had threads but wrote them all itself, in one subreddit. Attio
had fewer posts of its own but showed up inside threads other people started
asking what to buy. GummySearch shut down a year ago and still owns its
"alternative to" threads. So the score counts who wrote the mention and where
it sits, not how many there are.
"""
import re
from typing import Optional

from crawler import search_web, verified_reddit_threads

# What a reply can still be worth, by how the thread reads.
BUYING_INTENT = re.compile(
    r"\b(best|alternative|alternatives|vs\.?|versus|recommend|recommendations?|"
    r"worth it|switching|switch from|looking for|anyone using|which one|compare)\b",
    re.IGNORECASE,
)

WEIGHTS = {
    "earned_mentions": 25,
    "coverage_gap": 20,
    "buying_intent": 30,
    "competitor_gap": 15,
    "account_readiness": 10,
}

# Mentions from years ago still rank, but they are not the same as being part of
# the conversation now, so they are worth less rather than scored separately.
STALE_FLOOR = 0.4

# Old threads still rank in Google, but they say nothing about whether the brand
# is part of the conversation now.
FRESH_MONTHS = 6
STALE_YEARS = re.compile(r"(\d+)\s*(?:yr|year)s?\s*ago", re.IGNORECASE)
MONTHS_AGO = re.compile(r"(\d+)\s*(?:mo|month)s?\s*ago", re.IGNORECASE)


def _subreddit(result: dict) -> str:
    named = result.get("subreddit_name_prefixed") or ""
    if named:
        return named.lower()
    match = re.search(r"reddit\.com/r/([^/]+)", result.get("url", ""), re.IGNORECASE)
    return f"r/{match.group(1).lower()}" if match else ""


def _is_recent(result: dict) -> bool:
    text = f"{result.get('date', '')} {result.get('snippet', '')}"
    if STALE_YEARS.search(text):
        return False
    months = MONTHS_AGO.search(text)
    if months:
        return int(months.group(1)) <= FRESH_MONTHS
    return bool(result.get("date"))


def _written_by_them(result: dict, brand: str, usernames: set[str]) -> bool:
    """A launch post the brand wrote itself, rather than someone else's thread."""
    text = f"{result.get('title', '')} {result.get('snippet', '')}".lower()
    if any(f"u/{name}" in text or f"by {name}" in text for name in usernames if name):
        return True
    # "I built / I made / I launched <brand>" reads as the maker's own post.
    return bool(re.search(rf"\bi (?:built|made|launched|created)\b[^.]{{0,40}}{re.escape(brand.lower())}", text))


def _score_part(actual: float, target: float, points: int) -> int:
    if target <= 0:
        return points
    return int(round(min(1.0, actual / target) * points))


async def run_audit(
    brand: str,
    category: str,
    competitors: list[str],
    profile: Optional[dict] = None,
    known_usernames: Optional[set[str]] = None,
) -> dict:
    """Score how present a brand is on Reddit, and say what is missing."""
    brand = brand.strip()
    category = category.strip() or brand
    competitors = [c.strip() for c in competitors if c.strip()][:3]
    usernames = {u.lower() for u in (known_usernames or set()) if u}

    mentions = verified_reddit_threads(await search_web(brand, limit=10, reddit_only=True))
    category_threads = verified_reddit_threads(await search_web(category, limit=10, reddit_only=True))
    intent_threads = verified_reddit_threads(
        await search_web(f"best {category} recommend alternative", limit=10, reddit_only=True)
    )

    earned, self_posted = [], []
    for result in mentions:
        (self_posted if _written_by_them(result, brand, usernames) else earned).append(result)

    # Where the category is discussed, versus where this brand shows up at all.
    category_subs = {_subreddit(r) for r in category_threads + intent_threads if _subreddit(r)}
    present_subs = {_subreddit(r) for r in mentions if _subreddit(r)}
    missing_subs = sorted(category_subs - present_subs)

    # Threads where someone is choosing what to buy.
    intent = [r for r in intent_threads + category_threads if BUYING_INTENT.search(r.get("title", ""))]
    brand_in_intent = [r for r in intent if brand.lower() in f"{r.get('title','')} {r.get('snippet','')}".lower()]

    competitor_hits: dict[str, list[dict]] = {}
    for name in competitors:
        competitor_hits[name] = [
            r for r in intent if name.lower() in f"{r.get('title','')} {r.get('snippet','')}".lower()
        ]
    competitor_best = max((len(v) for v in competitor_hits.values()), default=0)

    karma = int((profile or {}).get("karma") or 0)
    account_years = float((profile or {}).get("account_age_years") or 0)

    recent = [r for r in earned if _is_recent(r)]
    # Search results do not always carry a date. Penalising a brand for that
    # would be guessing, so an undated set counts as current.
    dated = [r for r in earned if r.get("date")]
    freshness = 1.0 if not dated else STALE_FLOOR + (1 - STALE_FLOOR) * (len(recent) / len(dated))

    # When neither side shows up in the buying threads there is no gap to measure,
    # so the part is dropped and the score is out of what is left.
    competitor_measured = bool(competitors) and (competitor_best > 0 or len(brand_in_intent) > 0)

    parts = {
        # Eight earned mentions is a brand people actually bring up. Three is a start.
        # Worth less when they are all old.
        "earned_mentions": round(_score_part(len(earned), 8, WEIGHTS["earned_mentions"]) * freshness),
        # Being in half the subreddits that discuss your category is a fair bar.
        "coverage_gap": _score_part(len(present_subs), max(1, len(category_subs) * 0.5), WEIGHTS["coverage_gap"]),
        "buying_intent": _score_part(len(brand_in_intent), 3, WEIGHTS["buying_intent"]),
        # Full marks only when you appear at least as often as your strongest competitor.
        "competitor_gap": _score_part(len(brand_in_intent), max(1, competitor_best), WEIGHTS["competitor_gap"]) if competitor_measured else 0,
        "account_readiness": min(
            WEIGHTS["account_readiness"],
            (5 if karma >= 100 else 3 if karma >= 20 else 0) + (5 if account_years >= 1 else 3 if account_years >= 0.5 else 0),
        ),
    }
    out_of = sum(WEIGHTS.values()) - (0 if competitor_measured else WEIGHTS["competitor_gap"])
    score = round(sum(parts.values()) / out_of * 100)

    return {
        "brand": brand,
        "category": category,
        "score": score,
        "out_of": out_of,
        "competitor_measured": competitor_measured,
        "parts": [
            {"key": key, "label": label, "score": parts[key], "out_of": WEIGHTS[key], "detail": detail}
            for key, label, detail in [
                ("earned_mentions", "Earned mentions",
                 f"{len(earned)} threads about you that you didn't write"
                 + (f", {len(self_posted)} you did" if self_posted else "")
                 + (f" · only {len(recent)} in the last {FRESH_MONTHS} months" if dated and len(recent) < len(dated) else "")),
                ("coverage_gap", "Coverage gap", f"You appear in {len(present_subs)} of {len(category_subs)} communities discussing {category}"),
                ("buying_intent", "Buying-intent threads", f"Named in {len(brand_in_intent)} of {len(intent)} threads where people are choosing"),
                ("competitor_gap", "Competitor gap",
                 f"Your best-covered competitor appears in {competitor_best} of these threads, you in {len(brand_in_intent)}" if competitor_measured
                 else "Nobody is in these threads yet, yours or theirs, so this isn't counted" if competitors
                 else "Add competitors to compare"),
                ("account_readiness", "Account readiness", f"{karma} karma, account {account_years:.1f} years old" if profile else "Connect Reddit to check this"),
            ]
        ],
        "missing_communities": missing_subs[:10],
        "earned": [{"title": r.get("title", ""), "url": r.get("url", ""), "subreddit": _subreddit(r)} for r in earned[:6]],
        "self_posted": len(self_posted),
        "opportunities": [
            {"title": r.get("title", ""), "url": r.get("url", ""), "subreddit": _subreddit(r),
             "competitors_here": [name for name, hits in competitor_hits.items() if r in hits]}
            for r in intent if r not in brand_in_intent
        ][:8],
        "competitors": {name: len(hits) for name, hits in competitor_hits.items()},
    }
