"""
Search Query Lab engine: universal regex groups and the workbook's scoring.

Pure functions, no network. Every query is matched with RE2 (google-re2), the
engine Search Console itself uses, never Python's built-in `re`, whose syntax
and behaviour differ. The method is copied from the LegacyLeap workbook, tabs
20_Regex_Patterns and 21_Regex_Opportunities. Extra-click numbers are
ESTIMATES, not forecasts.
"""
import datetime as dt
import re  # only to split a brand name into words and parse timestamps; never used on queries

import re2

BUCKETS = ["1-3", "4-6", "7-10", "11-15", "16-20", "20+"]

# PROPOSAL (PRD 3.6): a bucket with fewer impressions than this is "low data".
# Rows whose target bucket is low data are not scored, so we never show a
# number we cannot back up.
LOW_DATA_IMPRESSIONS = 1000

# --- universal groups (exact, tested with RE2) ---------------------------------

QUESTIONS = r"(?i)^(who|what|why|how|when|where|which|can|does|do|is|are|should)\b|\b(who|what|why|how|when|where|which)\b"
BUYING_INTENT = r"(?i)\b(tools?|platforms?|software|services?|compan(y|ies)|vendors?|providers?|costs?|price|pricing|consult\w*|partners?|solutions?)\b"
COMPARISONS = r"(?i)\b(vs|versus|alternatives?|compare|comparison|best|top|reviews?)\b"
LONG_TAIL = r"^\S+(\s+\S+){4,}$"
AI_PROMPTS = r"^\S+(\s+\S+){9,}$"

BRAND = "Brand"
NON_BRAND = "Non-brand"
BUYING = "Buying intent"
COMPARISON = "Comparisons & alternatives"
QUESTION = "Questions"
LONG = "Long tail (5+ words)"
AI = "AI-style prompts (10+ words)"

GEO_ACTION = ("AI-style prompt (0 clicks at any position here). Treat as GEO: clear facts, "
              "tables and a one-line answer on the page; do not expect clicks.")

BASE_ACTIONS = [
    (3, "Ranks top 3 but CTR is low: rewrite title/meta to match this wording."),
    (10, "Page 1: add an answer-first paragraph and an H2 or FAQ using this exact wording; add 2-3 internal links."),
    (20, "Page 2: refresh the matching section, add an H2 with this wording, and add internal links from ranking posts."),
]
BEYOND_PAGE_2 = "Ranks beyond page 2: needs a dedicated page or a major new section."

ADD_ONS = [
    (BUYING, "Buying intent: add a clear services/assessment CTA."),
    (COMPARISON, "Comparison: add a comparison table."),
    (QUESTION, "Question: answer it in the first 2 sentences."),
]


def brand_regex(name: str) -> str:
    """
    Brand pattern from the name a person types. Split into words (spaces,
    hyphens, dots, underscores and camelCase), escape each for RE2, join with an
    optional space, prefix (?i). 'LegacyLeap' and 'Legacy Leap' both give
    (?i)legacy ?leap.
    """
    name = (name or "").strip()
    name = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name)
    words = [w for w in re.split(r"[\s\-_.]+", name.lower()) if w]
    if not words:
        raise ValueError("empty brand name")
    pattern = "(?i)" + " ?".join(re2.escape(w) for w in words)
    re2.compile(pattern)
    if len(pattern) > 4096:
        raise ValueError("brand name too long")
    return pattern


def universal_groups(brand_pattern: str) -> list:
    """name, pattern, mode ('match' or 'not-match'), plain-words description."""
    return [
        {"name": QUESTION, "pattern": QUESTIONS, "mode": "match", "finds": "Question-style searches (people asking)"},
        {"name": BUYING, "pattern": BUYING_INTENT, "mode": "match", "finds": "Looking for a tool, vendor, service or price"},
        {"name": COMPARISON, "pattern": COMPARISONS, "mode": "match", "finds": "Comparing options or looking for the best"},
        {"name": BRAND, "pattern": brand_pattern, "mode": "match", "finds": "Searches for your own brand"},
        {"name": NON_BRAND, "pattern": brand_pattern, "mode": "not-match", "finds": "Everything except your brand"},
        {"name": LONG, "pattern": LONG_TAIL, "mode": "match", "finds": "Queries with 5 or more words"},
        {"name": AI, "pattern": AI_PROMPTS, "mode": "match", "finds": "Queries with 10 or more words (AI-style prompts)"},
    ]


# --- scoring -------------------------------------------------------------------------

def bucket(position: float) -> str:
    for edge, name in ((3, "1-3"), (6, "4-6"), (10, "7-10"), (15, "11-15"), (20, "16-20")):
        if position <= edge:
            return name
    return "20+"


def target_bucket(name: str) -> str:
    """One bucket up. A row already in 1-3 stays in 1-3."""
    return BUCKETS[max(0, BUCKETS.index(name) - 1)]


def word_count(query: str) -> int:
    return len(query.split())


def build_benchmark(rows: list, brand_rx) -> dict:
    """
    The site's own CTR per position bucket: clicks / impressions over rows that
    are not brand and have fewer than 10 words.
    """
    agg = {b: [0.0, 0.0] for b in BUCKETS}
    for r in rows:
        q = r["query"]
        if brand_rx.search(q) or word_count(q) >= 10:
            continue
        a = agg[bucket(r["position"])]
        a[0] += r["clicks"] or 0
        a[1] += r["impressions"] or 0
    bench = {}
    for b in BUCKETS:
        clicks, impressions = agg[b]
        bench[b] = {
            "clicks": clicks,
            "impressions": impressions,
            "site_ctr": (clicks / impressions) if impressions else None,
            "low_data": impressions < LOW_DATA_IMPRESSIONS,
        }
    return bench


def action_text(position: float, groups: list, is_brand: bool, geo_flag: bool) -> str:
    if geo_flag:
        return GEO_ACTION
    if is_brand:
        return ""
    base = BEYOND_PAGE_2
    for edge, text in BASE_ACTIONS:
        if position <= edge:
            base = text
            break
    extras = [text for group, text in ADD_ONS if group in groups]
    return " ".join([base] + extras)


def score_rows(rows: list, brand_name: str) -> dict:
    """
    rows: dicts with query, clicks, impressions, position (and anything else,
    which is carried through untouched). Returns the brand pattern, the
    benchmark, and every row with its groups, bucket, target bucket, estimate
    and action.
    """
    brand_pattern = brand_regex(brand_name)
    brand_rx = re2.compile(brand_pattern)
    groups = [dict(g, rx=re2.compile(g["pattern"])) for g in universal_groups(brand_pattern)]
    bench = build_benchmark(rows, brand_rx)

    scored = []
    for r in rows:
        q = r["query"]
        impressions = r["impressions"] or 0
        clicks = r["clicks"] or 0
        position = r["position"]
        is_brand = bool(brand_rx.search(q))
        wc = word_count(q)
        geo_flag = wc >= 10
        member = [
            g["name"] for g in groups
            if bool(g["rx"].search(q)) != (g["mode"] == "not-match")
        ]
        b = bucket(position)
        t = target_bucket(b)

        low_data = False
        if is_brand or geo_flag:
            est = 0.0
        else:
            tb = bench[t]
            if tb["low_data"] or tb["site_ctr"] is None:
                est, low_data = None, True
            else:
                current = (clicks / impressions) if impressions else 0.0
                est = max(0.0, impressions * (tb["site_ctr"] - current))

        scored.append(dict(
            r,
            word_count=wc,
            is_brand=is_brand,
            geo_flag=geo_flag,
            groups=member,
            bucket=b,
            target_bucket=t,
            est_extra_clicks=est,
            low_data=low_data,
            action=action_text(position, member, is_brand, geo_flag),
        ))
    return {"brand_regex": brand_pattern, "benchmark": bench, "rows": scored}


def group_table(scored_rows: list) -> list:
    """
    One row per group, for the results screen. A query can be in several groups,
    so group totals do not add up to the whole.
    """
    names = [QUESTION, BUYING, COMPARISON, BRAND, NON_BRAND, LONG, AI]
    table = []
    for name in names:
        members = [r for r in scored_rows if name in r["groups"]]
        impressions = sum(r["impressions"] or 0 for r in members)
        clicks = sum(r["clicks"] or 0 for r in members)
        striking = [r for r in members if 4 <= r["position"] <= 20]
        page2 = [r for r in members if 10 < r["position"] <= 20]
        ranked = sorted(
            (r for r in members if r["est_extra_clicks"]),
            key=lambda r: r["est_extra_clicks"], reverse=True,
        )
        table.append({
            "group": name,
            "rows": len(members),
            "clicks": clicks,
            "impressions": impressions,
            "ctr": (clicks / impressions) if impressions else None,
            "avg_position": (sum(r["position"] * (r["impressions"] or 0) for r in members) / impressions) if impressions else None,
            "striking_distance": len(striking),
            "striking_distance_impressions": sum(r["impressions"] or 0 for r in striking),
            "page_2": len(page2),
            "page_2_impressions": sum(r["impressions"] or 0 for r in page2),
            "est_extra_clicks": sum(r["est_extra_clicks"] or 0 for r in members),
            "top_opportunities": [
                {"query": r["query"], "impressions": r["impressions"], "position": r["position"],
                 "est_extra_clicks": r["est_extra_clicks"]}
                for r in ranked[:3]
            ],
        })
    return table


def analyse(rows: list, brand_name: str) -> dict:
    result = score_rows(rows, brand_name)
    result["groups"] = group_table(result["rows"])
    return result


# --- the weekly gate, and the shape the results screen reads ---------------------

WEEKS = 4
ROWS_PER_WEEK = 25
CSV_SITE = "csv-upload"   # site_url stored for a run made from an uploaded Queries.csv


def _parse_ts(value: str) -> dt.datetime:
    """Postgres timestamps may carry 5 or 6 fractional digits; Python 3.9 wants 6."""
    value = value.replace("Z", "+00:00")
    value = re.sub(r"(\.\d+)", lambda m: (m.group(1) + "000000")[:7], value, count=1)
    parsed = dt.datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)


def week_info(row_count: int, created_at: str, now=None) -> dict:
    """
    Week 1 shows rows 1-25, week 2 rows 1-50, week 3 rows 1-75, week 4 all 100.
    Worked out from the stored run date; no Google call is ever made for it.
    """
    now = now or dt.datetime.now(dt.timezone.utc)
    weeks_since = max(0, int((now - _parse_ts(created_at)).total_seconds() // (7 * 86400)))
    return {
        "week": min(weeks_since + 1, WEEKS),
        "of": WEEKS,
        "visible_rows": min(row_count, ROWS_PER_WEEK * (weeks_since + 1)),
        "row_count": row_count,
    }


def build_view(run: dict, rows: list, now=None) -> dict:
    """
    What the results screen reads. The group table counts all stored rows
    (numbers only); the opportunity list holds only unlocked rows, so a locked
    row can never leave the server.
    """
    week = week_info(run["row_count"], run["created_at"], now)
    details = {g["name"]: g for g in universal_groups(run["brand_regex"])}
    unlocked = [r for r in rows if r["rank"] <= week["visible_rows"]]
    # Counts cover every stored row (numbers only). The "top opportunities" in a
    # group name actual queries, so they come from unlocked rows only.
    top_from_unlocked = {g["group"]: g["top_opportunities"] for g in group_table(unlocked)}
    groups = []
    for g in group_table(rows):
        d = details[g["group"]]
        groups.append(dict(
            g,
            top_opportunities=top_from_unlocked[g["group"]],
            pattern=d["pattern"],
            filter_type="Doesn't match regex" if d["mode"] == "not-match" else "Matches regex",
            finds=d["finds"],
        ))

    visible = [
        r for r in rows
        if r["rank"] <= week["visible_rows"]
        and not r["is_brand"] and not r["geo_flag"]
        and (r["est_extra_clicks"] is None or r["est_extra_clicks"] > 0)
    ]
    visible.sort(key=lambda r: (r["est_extra_clicks"] is None, -(r["est_extra_clicks"] or 0)))
    opportunities = [
        {k: r.get(k) for k in (
            "rank", "query", "page", "position", "clicks", "impressions", "est_extra_clicks",
            "low_data", "action", "groups", "bucket", "target_bucket",
        )}
        for r in visible
    ]
    return {
        "run": {k: run.get(k) for k in (
            "id", "site_url", "start_date", "end_date", "brand_name", "brand_regex", "created_at", "row_count",
        )},
        "from_csv": run.get("site_url") == CSV_SITE,
        "week": week,
        "benchmark": run.get("benchmark"),
        "groups": groups,
        "opportunities": opportunities,
    }


def pull_from_parsed(parsed: dict, today: str) -> dict:
    """
    Make a run-shaped pull from a parsed Queries.csv (search_console.parse_gsc):
    the top 100 rows by clicks, no page column. Rows without impressions or a
    position cannot be scored, so they are dropped.
    """
    usable = [
        r for r in parsed["rows"]
        if r.get("impressions") is not None and r.get("position") is not None
    ]
    if not usable:
        raise ValueError("That file has no rows with impressions and position, so it cannot be scored.")
    usable.sort(key=lambda r: r.get("clicks") or 0, reverse=True)
    rows = [
        {"rank": i, "query": r["key"], "page": "", "clicks": r.get("clicks") or 0,
         "impressions": r["impressions"], "ctr": r.get("ctr"), "position": r["position"]}
        for i, r in enumerate(usable[:100], start=1)
    ]
    return {"site_url": CSV_SITE, "start_date": today, "end_date": today, "row_count": len(rows), "rows": rows}
