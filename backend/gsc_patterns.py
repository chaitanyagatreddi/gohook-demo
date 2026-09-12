"""
Patterns, buckets and intent scoring over parsed Search Console rows.

Three jobs:
  1. classify each query by what the person wants      (pattern library)
  2. put it in one of three buckets                    (what to do about it)
  3. score it so the list sorts by what is worth doing (intent score)

No model calls and no network. Everything here runs on the rows already
parsed by search_console.parse_gsc.
"""
import re
from typing import Optional

# --- pattern library ------------------------------------------------------
# name, regex, intent class. Order matters only for readability; a query can
# match several and takes the highest weight, never the sum.
DEFAULT_PATTERNS = [
    ("questions",     r"^(who|what|why|how|when|where|which|can|does|is|are|should)\b", "question"),
    ("comparisons",   r"\b(vs|versus|compare|comparison|alternatives?|best|top \d+|review|reviews)\b", "comparison"),
    ("pricing",       r"\b(pricing|price|cost|costs|how much|cheap|free|discount)\b",   "buying"),
    ("complaints",    r"\b(problem|issue|error|broken|slow|bug|not working|hate)\b",    "problem"),
    ("buying intent", r"\b(buy|demo|trial|book|quote|near me|sign up)\b",               "buying"),
    ("long tail",     r"^(\S+\s+){4,}\S+$",                                             "question"),
]

# Pages exports carry URLs, not questions, so the query library would match
# almost nothing. Swap in URL shapes instead. See F7.
DEFAULT_PAGE_PATTERNS = [
    ("blog",          r"/(blog|posts?|articles?)/",      "question"),
    ("pricing pages", r"/(pricing|plans|price)",          "buying"),
    ("docs",          r"/(docs?|documentation|guide)",    "question"),
    ("comparisons",   r"/(vs|compare|alternatives?)",     "comparison"),
    ("home",          r"^/?$",                            "brand"),
]

INTENT_WEIGHT = {
    "buying": 1.0,
    "comparison": 0.8,
    "problem": 0.7,
    "question": 0.5,
    "brand": 0.2,
}

# Average CTR by position.
#
# UNVERIFIED. These are placeholder figures standing in for a published
# position/CTR study, and every intent score moves with them (F12). They are
# data, not logic, so they can be replaced or overridden per user without
# touching the scoring function. Do not show a score as a fact while this
# table is still the default.
BENCHMARK_CTR = {
    1: 0.28, 2: 0.15, 3: 0.11, 4: 0.08, 5: 0.06,
    6: 0.05, 7: 0.04, 8: 0.03, 9: 0.03, 10: 0.02,
}
BENCHMARK_CTR_TAIL = 0.01   # position 11 and beyond
BENCHMARK_VERSION = "placeholder-1"

# --- user-supplied pattern safety ----------------------------------------
MAX_PATTERN_LENGTH = 200

# Constructs RE2 does not have. Rejected so a pattern that works on an upload
# cannot be refused later by the Search Console API, and the other way round
# (F2). Nested quantifiers are rejected as well because Python's re has no
# timeout and will sit there backtracking (F1).
RE2_UNSUPPORTED = [
    (r"\(\?=", "lookahead (?=...)"),
    (r"\(\?!", "negative lookahead (?!...)"),
    (r"\(\?<=", "lookbehind (?<=...)"),
    (r"\(\?<!", "negative lookbehind (?<!...)"),
    (r"\\[1-9]", "backreference"),
    (r"\(\?P=", "named backreference"),
    (r"\(\?\(", "conditional"),
]
NESTED_QUANTIFIER = re.compile(r"\([^)]*[+*]\)[+*{]")


class PatternError(ValueError):
    """A pattern we refuse to run, with the reason the user needs told."""


def validate_pattern(pattern: str) -> None:
    """Raises PatternError. Silence means the pattern is safe to compile."""
    if not pattern or not pattern.strip():
        raise PatternError("Pattern is empty.")
    if len(pattern) > MAX_PATTERN_LENGTH:
        raise PatternError(
            f"Pattern is {len(pattern)} characters; the limit is {MAX_PATTERN_LENGTH}."
        )
    for probe, label in RE2_UNSUPPORTED:
        if re.search(probe, pattern):
            raise PatternError(
                f"Search Console uses RE2, which has no {label}. Rewrite without it."
            )
    if NESTED_QUANTIFIER.search(pattern):
        raise PatternError(
            "A repeat inside a repeat can hang on long queries. Simplify it."
        )
    try:
        re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        raise PatternError(f"Not a valid regex: {exc}")


# --- scoring --------------------------------------------------------------
def benchmark_ctr(position: Optional[float]) -> float:
    if position is None:
        return BENCHMARK_CTR_TAIL
    p = int(round(position))
    if p < 1:
        p = 1
    return BENCHMARK_CTR.get(p, BENCHMARK_CTR_TAIL)


def missed_opportunity(row: dict) -> float:
    """Clicks the position should have earned, minus the clicks it got."""
    impressions = row.get("impressions") or 0
    clicks = row.get("clicks") or 0
    expected = impressions * benchmark_ctr(row.get("position"))
    return max(0.0, expected - clicks)


def intent_of(key: str, patterns) -> tuple:
    """
    Returns (matched pattern names, intent class, weight).

    A query matching more than one class takes the highest weight, not the
    sum — "hubspot pricing vs salesforce" is one buying query, not 1.8 of one.
    """
    names, best_class, best_weight = [], None, 0.0
    for name, pattern, klass in patterns:
        if re.search(pattern, key, re.IGNORECASE):
            names.append(name)
            weight = INTENT_WEIGHT.get(klass, 0.0)
            if weight > best_weight:
                best_class, best_weight = klass, weight
    return names, best_class, best_weight


def bucket_of(row: dict, intent_class: Optional[str], median_impressions: float) -> str:
    """
    Exactly one bucket per row. Order is 2, then 1, then 3, so a query that
    already ranks but is badly titled is never sent off to Reddit (F13).
    """
    position = row.get("position")
    impressions = row.get("impressions") or 0
    ctr = row.get("ctr")

    if position is not None and position <= 10:
        expected = benchmark_ctr(position)
        if ctr is not None and ctr < expected * 0.5 and impressions > 0:
            return "seen_not_clicked"
    if position is not None and 10 < position <= 20 and impressions >= median_impressions:
        return "nearly_there"
    return "will_never_rank"


BUCKET_LABEL = {
    "seen_not_clicked": "Seen, not clicked",
    "nearly_there": "Nearly there",
    "will_never_rank": "Will never rank",
}
BUCKET_ACTION = {
    "seen_not_clicked": "Rewrite the title and description.",
    "nearly_there": "Improve the page — title, content, internal links.",
    "will_never_rank": "Go to Reddit. This is where the threads are.",
}


def _median(values) -> float:
    real = sorted(v for v in values if v is not None)
    if not real:
        return 0.0
    mid = len(real) // 2
    if len(real) % 2:
        return float(real[mid])
    return (real[mid - 1] + real[mid]) / 2.0


def analyse(rows, key_kind: str = "query", extra_patterns=None, limit: Optional[int] = 100,
            sort_by: str = "impressions") -> dict:
    """
    Score and bucket a slice of rows.

    `limit` is the top-N slice the UI shows by default; None means all of
    them. Every count returned says which slice it came from, so a top-100
    number is never read as a whole-file number (F10).
    """
    base = DEFAULT_PAGE_PATTERNS if key_kind == "page" else DEFAULT_PATTERNS
    patterns = list(base) + list(extra_patterns or [])

    ordered = sorted(
        rows,
        key=lambda r: (r.get(sort_by) if r.get(sort_by) is not None else -1),
        reverse=(sort_by != "position"),
    )
    sliced = ordered[:limit] if limit else ordered
    median_impressions = _median([r.get("impressions") for r in sliced])

    scored, pattern_counts, bucket_counts = [], {}, {}
    for row in sliced:
        names, klass, weight = intent_of(row["key"], patterns)
        missed = missed_opportunity(row)
        bucket = bucket_of(row, klass, median_impressions)
        for n in names:
            pattern_counts[n] = pattern_counts.get(n, 0) + 1
        bucket_counts[bucket] = bucket_counts.get(bucket, 0) + 1
        scored.append({
            **row,
            "patterns": names,
            "intent_class": klass,
            "intent_weight": weight,
            "missed_clicks": round(missed, 1),
            "intent_score": round(weight * missed, 1),
            "bucket": bucket,
        })

    scored.sort(key=lambda r: r["intent_score"], reverse=True)

    # Whole-file pattern counts, so an empty slice result is not read as
    # "I have no pricing queries" (F10).
    whole_file_counts = {}
    for row in rows:
        names, _, _ = intent_of(row["key"], patterns)
        for n in names:
            whole_file_counts[n] = whole_file_counts.get(n, 0) + 1

    return {
        "key_kind": key_kind,
        "slice_size": len(scored),
        "total_rows": len(rows),
        "sorted_by": sort_by,
        "benchmark_version": BENCHMARK_VERSION,
        "benchmark_is_placeholder": True,
        "pattern_counts_in_slice": pattern_counts,
        "pattern_counts_whole_file": whole_file_counts,
        "bucket_counts": bucket_counts,
        "rows": scored,
    }
