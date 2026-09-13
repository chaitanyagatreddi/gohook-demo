import re
import httpx
import os
from dotenv import load_dotenv

load_dotenv()

SERPER_API_KEY = os.getenv("SERPER_API_KEY")
SERPER_URL = "https://google.serper.dev/search"


async def search_reddit(client: httpx.AsyncClient, query: str) -> list[dict]:
    if not SERPER_API_KEY:
        raise ValueError("SERPER_API_KEY not set in .env")

    payload = {
        "q": f"{query} reddit",
        "num": 20,
    }
    headers = {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json",
    }

    resp = await client.post(SERPER_URL, json=payload, headers=headers, timeout=15)
    resp.raise_for_status()
    data = resp.json()

    posts = []
    import re
    for item in data.get("organic", []):
        url = item.get("link", "")
        # Only keep reddit.com results
        if "reddit.com" not in url:
            continue
        sub_match = re.search(r"reddit\.com/r/([^/]+)", url)
        subreddit = f"r/{sub_match.group(1)}" if sub_match else "r/unknown"

        # Strip scheme + host so extractors can prepend https://reddit.com cleanly
        permalink = re.sub(r"^https?://(www\.|old\.|new\.)?reddit\.com", "", url)

        posts.append({
            "title": item.get("title", ""),
            "selftext": item.get("snippet", ""),
            "score": 0,
            "permalink": permalink,
            "subreddit_name_prefixed": subreddit,
            "url": url,
        })

    return posts


BASE_QUERIES = ["", "pricing review", "complaint alternative switched"]
EXPAND_QUERIES = [
    "worth it honest",
    "vs alternative",
    "experience after months",
    "stopped using cancelled",
    "is good or bad",
]


async def search_many(queries: list[str], limit: int = 20) -> list[dict]:
    """Run several Reddit searches in parallel, dedupe by permalink, cap at limit."""
    import asyncio

    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(
            *(search_reddit(client, q) for q in queries if q.strip()),
            return_exceptions=True,
        )

    posts, seen = [], set()
    for batch in results:
        if isinstance(batch, Exception):
            continue
        for p in batch:
            key = p["permalink"].split("?")[0].split("#")[0].rstrip("/")
            if key not in seen:
                seen.add(key)
                posts.append(p)
    return posts[:limit]


async def crawl_reddit(query: str, subreddits: list[str], expand: bool = False) -> list[dict]:
    all_posts = []
    seen_urls = set()

    queries = BASE_QUERIES + (EXPAND_QUERIES if expand else [])

    async with httpx.AsyncClient() as client:
        for extra in queries:
            q = f"{query} {extra}".strip()
            posts = await search_reddit(client, q)
            for p in posts:
                dedup_key = p["permalink"].split("?")[0].split("#")[0].rstrip("/")
                if dedup_key not in seen_urls:
                    seen_urls.add(dedup_key)
                    all_posts.append(p)

    return all_posts


async def search_web(query: str, limit: int = 6, reddit_only: bool = False) -> list[dict]:
    """
    Plain web search — no "reddit" added, no Reddit-only filter.
    Used to answer factual questions from sources instead of memory.
    Returns: [{title, snippet, url, site, date}]
    """
    if not SERPER_API_KEY:
        raise ValueError("SERPER_API_KEY not set in .env")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            SERPER_URL,
            # reddit_only keeps every result on Reddit, for the Questions page.
            json={"q": f"{query} site:reddit.com" if reddit_only else query, "num": limit},
            headers={"X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json"},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

    results = []

    # Google's own answer box, when there is one, is usually the freshest fact.
    box = data.get("answerBox") or {}
    box_text = box.get("answer") or box.get("snippet")
    if box_text and not reddit_only:
        results.append({
            "title": box.get("title", "Answer box"),
            "snippet": box_text,
            "url": box.get("link", ""),
            "site": "google answer box",
            "date": "",
        })

    for item in data.get("organic", [])[:limit]:
        url = item.get("link", "")
        site = re.sub(r"^https?://(www\.)?", "", url).split("/")[0] if url else ""
        result = {
            "title": item.get("title", ""),
            "snippet": item.get("snippet", ""),
            "url": url,
            "site": site,
            "date": item.get("date", ""),
        }
        if reddit_only:
            sub_match = re.search(r"reddit\.com/r/([^/]+)", url)
            result["permalink"] = re.sub(r"^https?://(www\.|old\.|new\.)?reddit\.com", "", url)
            result["subreddit_name_prefixed"] = f"r/{sub_match.group(1)}" if sub_match else ""
            result["selftext"] = item.get("snippet", "")
            result["score"] = 0
        results.append(result)

    return results


def verified_reddit_threads(results: list[dict]) -> list[dict]:
    """Keep only complete Reddit thread records that can safely enter a graph."""
    threads, seen = [], set()
    for result in results:
        url = result.get("url", "")
        permalink = result.get("permalink", "")
        subreddit = result.get("subreddit_name_prefixed", "")
        if not permalink or not subreddit or "/comments/" not in url:
            continue
        key = permalink.split("?")[0].split("#")[0].rstrip("/")
        if not key or key in seen:
            continue
        seen.add(key)
        threads.append(result)
    return threads


async def research_reddit_with_review(question: str, limit: int = 6) -> tuple[list[dict], dict]:
    """Research Reddit, then make one focused retry if the evidence is incomplete."""
    initial = await search_web(question, limit=limit, reddit_only=True)
    threads = verified_reddit_threads(initial)
    communities = {t["subreddit_name_prefixed"] for t in threads}
    retried = len(threads) < 3 or len(communities) < 2

    if retried:
        retry = await search_web(f"{question} experience discussion", limit=limit, reddit_only=True)
        threads = verified_reddit_threads(initial + retry)
        communities = {t["subreddit_name_prefixed"] for t in threads}

    return threads[:limit], {
        "checked": len(initial) + (limit if retried else 0),
        "verified": len(threads[:limit]),
        "communities": len(communities),
        "retried": retried,
        "passed": len(threads) >= 3 and len(communities) >= 2,
    }
