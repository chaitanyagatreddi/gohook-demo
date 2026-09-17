"""
Reddit connecting, through Composio.

GoHook never sees or stores anyone's Reddit password or tokens. Composio holds
those. We keep one row saying which Composio connection belongs to which GoHook
account, and we ask Composio to act on that person's behalf when we need to.

Read only. Nothing here posts, comments, votes or messages.
"""
import logging
import os
from typing import Optional

import httpx
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

# Must be v3.1. Version 3 exposes only 10 Reddit tools and hides the
# profile ones; 3.1 has all 23. Checked 2026-09-12.
API = "https://backend.composio.dev/api/v3.1"
COMPOSIO_API_KEY = os.getenv("COMPOSIO_API_KEY")
REDDIT_AUTH_CONFIG_ID = os.getenv("COMPOSIO_REDDIT_AUTH_CONFIG_ID")

# How many of a person's own posts we pull on connect. Same cap as topic
# tagging, so one connect costs about the same as one question.
MAX_OWN_POSTS = 12


class NotConfigured(RuntimeError):
    """Composio settings are missing, so connecting cannot work."""


def _headers() -> dict:
    if not COMPOSIO_API_KEY or not REDDIT_AUTH_CONFIG_ID:
        raise NotConfigured("COMPOSIO_API_KEY and COMPOSIO_REDDIT_AUTH_CONFIG_ID must be set")
    return {"x-api-key": COMPOSIO_API_KEY, "Content-Type": "application/json"}


# Where people may be sent back to after signing into Reddit. Anything else is
# refused, so the link can't be used to bounce someone to a stranger's site.
RETURN_ORIGINS = {
    "https://gohooklive.vercel.app",
    "https://gohooklive-git-staging-chaitanya-s-projects93.vercel.app",
    "https://redditscan.vercel.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}
DEFAULT_RETURN = "https://gohooklive.vercel.app"


async def create_connect_link(user_id: str, return_origin: Optional[str] = None) -> dict:
    """
    Ask Composio for a sign-in page for this person.

    We pass the GoHook account id as Composio's user id, so the connection is
    filed under the right person. After signing in, Composio sends them back to
    the site they started on, if it is one of ours. Without this Composio falls
    back to localhost:3000, which does not exist.
    """
    origin = (return_origin or "").rstrip("/")
    if origin not in RETURN_ORIGINS:
        origin = DEFAULT_RETURN

    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{API}/connected_accounts/link",
            headers=_headers(),
            json={
                "auth_config_id": REDDIT_AUTH_CONFIG_ID,
                "user_id": user_id,
                "callback_url": f"{origin}/?reddit=connected",
            },
            timeout=30,
        )
        res.raise_for_status()
        out = res.json()

    return {
        "url": out["redirect_url"],
        "connected_account_id": out.get("connected_account_id"),
        "expires_at": out.get("expires_at"),
    }


async def connection_status(connected_account_id: str) -> str:
    """
    Where a connection stands, in Composio's words: INITIATED, ACTIVE, EXPIRED,
    FAILED. Returns 'UNKNOWN' if Composio will not say.
    """
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{API}/connected_accounts/{connected_account_id}",
            headers=_headers(),
            timeout=30,
        )
        if res.status_code == 404:
            return "MISSING"
        res.raise_for_status()
        return res.json().get("status", "UNKNOWN")


async def _run(tool: str, user_id: str, arguments: dict) -> dict:
    """Run one Reddit tool as this person."""
    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{API}/tools/execute/{tool}",
            headers=_headers(),
            json={"user_id": user_id, "arguments": arguments},
            timeout=60,
        )
        res.raise_for_status()
        return res.json()


def _unwrap(out: dict) -> dict:
    """Composio wraps the Reddit reply differently per tool. Dig it out."""
    data = out.get("data") or {}
    if not isinstance(data, dict):
        return {}
    inner = data.get("response_data")
    return inner if isinstance(inner, dict) else data


async def get_profile(connected_account_id: str) -> Optional[dict]:
    """
    The person's Reddit profile: username, karma, when the account was made.

    No Composio tool answers "who am I" — REDDIT_GET_ME_PREFS returns settings
    with no username, and REDDIT_GET_REDDIT_USER_ABOUT needs the username you
    are trying to find. So this passes a plain request through the connection to
    Reddit's own identity address. Checked working 2026-09-12.

    None if Composio cannot reach it.
    """
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{API}/tools/execute/proxy",
                headers=_headers(),
                json={
                    "endpoint": "/api/v1/me",
                    "method": "GET",
                    "connected_account_id": connected_account_id,
                },
                timeout=45,
            )
            res.raise_for_status()
            out = res.json()
    except Exception:
        logger.exception("Could not read Reddit profile")
        return None

    info = _unwrap(out)
    if not info:
        return None

    return {
        "username": info.get("name"),
        "karma": info.get("total_karma"),
        "link_karma": info.get("link_karma"),
        "comment_karma": info.get("comment_karma"),
        "created_utc": info.get("created_utc"),
    }


async def get_post_json(connected_account_id: str, permalink: str):
    """Read one Reddit thread through the person's authenticated connection."""
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{API}/tools/execute/proxy",
                headers=_headers(),
                json={
                    "endpoint": f"{permalink.rstrip('/')}.json?raw_json=1",
                    "method": "GET",
                    "connected_account_id": connected_account_id,
                },
                timeout=45,
            )
            res.raise_for_status()
            data = res.json().get("data")
            if isinstance(data, list):
                return data
            data = data or {}
            return data.get("response_data") or data
    except Exception:
        logger.exception("Could not read Reddit thread through the connection")
        return None


async def get_own_posts(user_id: str, username: str, limit: int = MAX_OWN_POSTS) -> list[dict]:
    """
    The person's own posts.

    There is no Composio tool that lists someone's posts, so this searches for
    author:<username>. That means it is a search, not a complete history —
    older or low-scoring posts may not come back.

    Returns results shaped like the rest of the app expects, so they can go
    straight into the graph.
    """
    if not username:
        return []

    try:
        out = await _run(
            "REDDIT_SEARCH_ACROSS_SUBREDDITS",
            user_id,
            {
                "search_query": f"author:{username}",
                "limit": limit,
                "sort": "new",
                # Must be off, or Reddit confines the search to one subreddit
                # and a person's posts are spread across many.
                "restrict_sr": False,
            },
        )
    except Exception:
        logger.exception("Could not search this person's own posts")
        return []

    # Composio hands back {"posts": [...]}, each post already flat — not
    # Reddit's raw {"children": [{"data": ...}]}. Checked live 2026-09-12.
    info = _unwrap(out)
    found = info.get("posts") or info.get("children") or []

    posts = []
    for entry in found[:limit]:
        if not isinstance(entry, dict):
            continue
        item = entry.get("data") if isinstance(entry.get("data"), dict) else entry
        permalink = item.get("permalink") or ""
        if not permalink:
            continue

        subreddit = item.get("subreddit_prefixed") or item.get("subreddit_name_prefixed") or ""
        if not subreddit and item.get("subreddit"):
            subreddit = f"r/{item['subreddit']}"

        posts.append({
            "title": item.get("title", ""),
            "selftext": item.get("selftext", "") or "",
            "score": item.get("score", 0),
            "permalink": permalink,
            "subreddit_name_prefixed": subreddit,
            "url": item.get("url") or f"https://reddit.com{permalink}",
            "author": item.get("author", username),
            "over_18": bool(item.get("over_18")),
        })
    return posts


# ---------------------------------------------------------------------------
# Remembering the connection in Supabase
# ---------------------------------------------------------------------------

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")


def _db_headers() -> dict:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise NotConfigured("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    return {
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
    }


async def save_connection(user_id: str, connected_account_id: str, status: str,
                          profile: Optional[dict] = None) -> None:
    """Write down which Composio connection belongs to this GoHook account."""
    row = {
        "user_id": user_id,
        "connected_account_id": connected_account_id,
        "status": status,
        "updated_at": "now()",
    }
    if profile:
        row["reddit_username"] = profile.get("username")
        row["meta"] = {
            "karma": profile.get("karma"),
            "link_karma": profile.get("link_karma"),
            "comment_karma": profile.get("comment_karma"),
            "created_utc": profile.get("created_utc"),
        }

    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{SUPABASE_URL}/rest/v1/reddit_connections",
            headers={**_db_headers(), "Prefer": "resolution=merge-duplicates,return=minimal"},
            params={"on_conflict": "user_id"},
            json=[row],
            timeout=30,
        )
        res.raise_for_status()


async def read_connection(user_id: str) -> Optional[dict]:
    """What we have saved for this person, or None."""
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/reddit_connections",
            headers=_db_headers(),
            params={
                "user_id": f"eq.{user_id}",
                "select": "connected_account_id,reddit_username,status,meta,last_synced_at",
            },
            timeout=30,
        )
        res.raise_for_status()
        rows = res.json()
    return rows[0] if rows else None


async def mark_synced(user_id: str) -> None:
    """Record that we just pulled this person's posts."""
    async with httpx.AsyncClient() as client:
        res = await client.patch(
            f"{SUPABASE_URL}/rest/v1/reddit_connections",
            headers={**_db_headers(), "Prefer": "return=minimal"},
            params={"user_id": f"eq.{user_id}"},
            json={"last_synced_at": "now()", "updated_at": "now()"},
            timeout=30,
        )
        res.raise_for_status()
