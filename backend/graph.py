"""
Knowledge graph — turns Reddit search results into nodes and edges in Supabase.

Shared content (threads, subreddits, authors) is stored once in `nodes` / `edges`.
Anything belonging to a person (topics, saves, citations) lives in `user_nodes` /
`user_edges` and is written under that person's user_id.

No model calls in this file. Topic extraction lives in topics.py.
"""
import os
import re
from typing import Optional
from datetime import datetime, timedelta, timezone

import httpx
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

# Serper gives us a permalink but no Reddit id, so we read the id out of the URL.
# /r/<sub>/comments/<id>/<slug>/  ->  <id>
THREAD_ID_PATTERN = re.compile(r"/comments/([a-z0-9]+)", re.IGNORECASE)
SUBREDDIT_PATTERN = re.compile(r"/r/([^/]+)", re.IGNORECASE)

# Keep stored text short — the free Supabase plan is the constraint.
# Full text is kept only for threads the user actually saves.
BODY_LIMIT = 600


def _headers() -> dict:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    return {
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
    }


def thread_id_from_permalink(permalink: str) -> Optional[str]:
    """Reddit's own thread id, pulled from the permalink. None if it isn't a thread URL."""
    if not permalink:
        return None
    match = THREAD_ID_PATTERN.search(permalink)
    return match.group(1).lower() if match else None


def subreddit_from(thread: dict) -> Optional[str]:
    """Normalised subreddit name without the r/ prefix."""
    prefixed = thread.get("subreddit_name_prefixed") or ""
    if prefixed.startswith("r/"):
        name = prefixed[2:]
    else:
        match = SUBREDDIT_PATTERN.search(thread.get("permalink") or thread.get("url") or "")
        name = match.group(1) if match else ""
    name = name.strip().lower()
    return name or None


async def _upsert_nodes(client: httpx.AsyncClient, rows: list[dict]) -> dict[tuple[str, str], str]:
    """
    Insert or update shared nodes, keyed on (type, source_id) so the same thread
    arriving twice updates instead of duplicating.
    Returns a lookup of (type, source_id) -> node id.
    """
    if not rows:
        return {}

    res = await client.post(
        f"{SUPABASE_URL}/rest/v1/nodes",
        headers={**_headers(), "Prefer": "resolution=merge-duplicates,return=representation"},
        params={"on_conflict": "type,source_id"},
        json=rows,
        timeout=30,
    )
    res.raise_for_status()
    return {(r["type"], r["source_id"]): r["id"] for r in res.json()}


async def _upsert_edges(client: httpx.AsyncClient, rows: list[dict]) -> None:
    """Insert shared structural edges, ignoring ones that already exist."""
    if not rows:
        return
    res = await client.post(
        f"{SUPABASE_URL}/rest/v1/edges",
        headers={**_headers(), "Prefer": "resolution=ignore-duplicates,return=minimal"},
        params={"on_conflict": "from_node,to_node,type"},
        json=rows,
        timeout=30,
    )
    res.raise_for_status()


async def ingest_threads(threads: list[dict]) -> dict[str, str]:
    """
    Put a batch of search results into the shared layer.

    Creates a thread node per result, a subreddit node per distinct subreddit,
    and a posted_in edge between them.

    Returns a lookup of Reddit thread id -> node id, so callers can attach their
    own per-user edges afterwards.
    """
    if not threads:
        return {}

    # No author handling here on purpose: Serper results carry no author field
    # (see crawler.py), so author nodes wait until we fetch full threads.
    thread_rows, subreddit_names = [], set()
    parsed = []

    for t in threads:
        permalink = t.get("permalink") or t.get("url") or ""
        thread_id = thread_id_from_permalink(permalink)
        if not thread_id:
            continue  # not a thread URL, nothing stable to key on

        subreddit = subreddit_from(t)
        if subreddit:
            subreddit_names.add(subreddit)

        parsed.append((thread_id, subreddit))
        thread_rows.append({
            "type": "thread",
            "source_id": thread_id,
            "title": (t.get("title") or "")[:300],
            "body": (t.get("selftext") or "")[:BODY_LIMIT],
            "permalink": permalink,
            "meta": {
                "score": t.get("score", 0),
                "url": t.get("url", ""),
                # Reddit's own over-18 mark. Shown as a tag on the graph.
                "over_18": bool(t.get("over_18")),
            },
        })

    if not thread_rows:
        return {}

    subreddit_rows = [
        {"type": "subreddit", "source_id": name, "title": f"r/{name}"}
        for name in sorted(subreddit_names)
    ]
    async with httpx.AsyncClient() as client:
        ids = await _upsert_nodes(client, thread_rows)
        ids.update(await _upsert_nodes(client, subreddit_rows))

        edge_rows = []
        for thread_id, subreddit in parsed:
            from_id = ids.get(("thread", thread_id))
            if not from_id or not subreddit:
                continue
            if ("subreddit", subreddit) in ids:
                edge_rows.append({
                    "from_node": from_id,
                    "to_node": ids[("subreddit", subreddit)],
                    "type": "posted_in",
                })

        await _upsert_edges(client, edge_rows)

    return {tid: ids[("thread", tid)] for tid, _ in parsed if ("thread", tid) in ids}


async def _self_node_id(client: httpx.AsyncClient, user_id: str) -> str:
    """
    The single node standing for the user themselves. Every 'saved' / 'cited' /
    'authored' edge starts here, so those edges have a real starting point.
    Created on first use.
    """
    res = await client.post(
        f"{SUPABASE_URL}/rest/v1/user_nodes",
        headers={**_headers(), "Prefer": "resolution=merge-duplicates,return=representation"},
        params={"on_conflict": "user_id,type,label"},
        json=[{"user_id": user_id, "type": "self", "label": "me"}],
        timeout=30,
    )
    res.raise_for_status()
    return res.json()[0]["id"]


async def link_user_to_threads(user_id: str, node_ids: list[str], edge_type: str) -> None:
    """
    Record something the user did with these threads — 'saved', 'cited' or 'authored'.
    Safe to call twice; duplicates are ignored.
    """
    if not user_id or not node_ids or edge_type not in ("saved", "cited", "authored"):
        return

    async with httpx.AsyncClient() as client:
        self_id = await _self_node_id(client, user_id)

        rows = [
            {
                "user_id": user_id,
                "from_table": "user_nodes",
                "from_id": self_id,
                "to_table": "nodes",
                "to_id": node_id,
                "type": edge_type,
            }
            for node_id in dict.fromkeys(node_ids)
        ]

        res = await client.post(
            f"{SUPABASE_URL}/rest/v1/user_edges",
            headers={**_headers(), "Prefer": "resolution=ignore-duplicates,return=minimal"},
            params={"on_conflict": "user_id,from_table,from_id,to_table,to_id,type"},
            json=rows,
            timeout=30,
        )
        res.raise_for_status()


async def save_question_memory(user_id: str, question: str, answer: Optional[dict] = None) -> None:
    """Keep a person's question and completed answer in their private graph layer."""
    if not user_id or not question.strip():
        return
    memory = {
        "answer": str((answer or {}).get("answer", "")).strip(),
        "sources": (answer or {}).get("sources", [])[:6],
        "withheld": bool((answer or {}).get("withheld", False)),
    }
    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{SUPABASE_URL}/rest/v1/user_nodes",
            headers={**_headers(), "Prefer": f"resolution={'merge-duplicates' if answer is not None else 'ignore-duplicates'},return=minimal"},
            params={"on_conflict": "user_id,type,label"},
            json=[{
                "user_id": user_id,
                "type": "question",
                "label": question.strip(),
                "meta": memory,
            }],
            timeout=30,
        )
        res.raise_for_status()


async def read_question_memory(user_id: Optional[str], limit: int = 20) -> list[dict]:
    """Return the signed-in person's completed question history, newest first."""
    if not user_id:
        return []
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/user_nodes",
            headers=_headers(),
            params={
                "user_id": f"eq.{user_id}",
                "type": "eq.question",
                "select": "label,meta,created_at",
                "order": "created_at.desc",
                "limit": str(limit),
            },
            timeout=30,
        )
        res.raise_for_status()
    memories = []
    for row in res.json():
        meta = row.get("meta") or {}
        memories.append({
            "question": row.get("label", ""),
            "answer": meta.get("answer", ""),
            "sources": meta.get("sources", []),
            "saved_at": row.get("created_at"),
        })
    return memories


async def read_graph(user_id: Optional[str], limit: int = 300) -> dict:
    """
    Everything needed to draw the picture: the threads and subreddits this person
    has touched, their topics, and the links between them.

    Someone not signed in gets an empty graph rather than someone else's.
    """
    empty = {"nodes": [], "edges": []}
    if not user_id:
        return empty

    async with httpx.AsyncClient() as client:
        # The person's own edges first — this is what decides which threads
        # belong to them.
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/user_edges",
            headers=_headers(),
            params={
                "user_id": f"eq.{user_id}",
                "select": "from_table,from_id,to_table,to_id,type",
                "limit": str(limit * 3),
            },
            timeout=30,
        )
        res.raise_for_status()
        user_edges = res.json()

        thread_ids = sorted({
            e["to_id"] for e in user_edges
            if e["to_table"] == "nodes"
        } | {
            e["from_id"] for e in user_edges
            if e["from_table"] == "nodes"
        })
        topic_ids = sorted({
            e["to_id"] for e in user_edges if e["to_table"] == "user_nodes"
        } | {
            e["from_id"] for e in user_edges if e["from_table"] == "user_nodes"
        })

        if not thread_ids and not topic_ids:
            return empty

        shared_nodes, shared_edges, topic_nodes = [], [], []

        if thread_ids:
            ids = ",".join(thread_ids[:limit])
            res = await client.get(
                f"{SUPABASE_URL}/rest/v1/nodes",
                headers=_headers(),
                params={"id": f"in.({ids})", "select": "id,type,title,permalink,meta,captured_at"},
                timeout=30,
            )
            res.raise_for_status()
            shared_nodes = res.json()

            # Subreddits these threads sit in, plus the links to them.
            res = await client.get(
                f"{SUPABASE_URL}/rest/v1/edges",
                headers=_headers(),
                params={
                    "from_node": f"in.({ids})",
                    "select": "from_node,to_node,type",
                    "limit": str(limit * 3),
                },
                timeout=30,
            )
            res.raise_for_status()
            shared_edges = res.json()

            subreddit_ids = sorted({e["to_node"] for e in shared_edges})
            if subreddit_ids:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/nodes",
                    headers=_headers(),
                    params={
                        "id": f"in.({','.join(subreddit_ids)})",
                        "select": "id,type,title,permalink,meta,captured_at",
                    },
                    timeout=30,
                )
                res.raise_for_status()
                shared_nodes += res.json()

        if topic_ids:
            res = await client.get(
                f"{SUPABASE_URL}/rest/v1/user_nodes",
                headers=_headers(),
                params={
                    "id": f"in.({','.join(topic_ids[:limit])})",
                    "user_id": f"eq.{user_id}",
                    "select": "id,type,label",
                },
                timeout=30,
            )
            res.raise_for_status()
            # The 'self' node stands for the person; it is not drawn.
            topic_nodes = [r for r in res.json() if r["type"] != "self"]

    drawn = {n["id"] for n in shared_nodes} | {n["id"] for n in topic_nodes}

    # How each thread got into this person's graph: from a question they asked
    # ('cited'), from their Board ('saved'), or from their own Reddit ('authored').
    how = {}
    for e in user_edges:
        if e["type"] in ("cited", "saved", "authored") and e["to_table"] == "nodes":
            how.setdefault(e["to_id"], []).append(e["type"])

    nodes = [
        {
            "id": n["id"],
            "kind": n["type"],
            "label": n.get("title") or "(untitled)",
            "permalink": n.get("permalink"),
            "how": sorted(set(how.get(n["id"], []))),
            "over_18": bool((n.get("meta") or {}).get("over_18")),
            "score": (n.get("meta") or {}).get("score"),
            "captured_at": n.get("captured_at"),
        }
        for n in shared_nodes
    ] + [
        {"id": n["id"], "kind": "topic", "label": n["label"]}
        for n in topic_nodes
    ]

    edges = [
        {"from": e["from_node"], "to": e["to_node"], "type": e["type"]}
        for e in shared_edges
        if e["from_node"] in drawn and e["to_node"] in drawn
    ] + [
        {"from": e["from_id"], "to": e["to_id"], "type": e["type"]}
        for e in user_edges
        if e["from_id"] in drawn and e["to_id"] in drawn
    ]

    return {"nodes": nodes, "edges": edges}


async def read_voice_profile(user_id: Optional[str]) -> Optional[dict]:
    """The person's saved writing style, or None when they haven't set one up."""
    if not user_id:
        return None
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/voice_profiles",
            headers=_headers(),
            params={"user_id": f"eq.{user_id}", "select": "style,sample_count,source,updated_at", "limit": 1},
            timeout=15,
        )
        res.raise_for_status()
        rows = res.json()
    return rows[0] if rows else None


async def save_voice_profile(user_id: str, style: dict, sample_count: int, source: str) -> dict:
    """Store the style summary only. The writing someone pastes is never saved."""
    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{SUPABASE_URL}/rest/v1/voice_profiles",
            headers={**_headers(), "Prefer": "resolution=merge-duplicates,return=representation"},
            params={"on_conflict": "user_id"},
            json=[{
                "user_id": user_id,
                "style": style,
                "sample_count": sample_count,
                "source": source if source in ("paste", "reddit") else "paste",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }],
            timeout=15,
        )
        res.raise_for_status()
        rows = res.json()
    return rows[0] if rows else {}


async def delete_voice_profile(user_id: str) -> None:
    """Remove the saved style completely."""
    async with httpx.AsyncClient() as client:
        res = await client.delete(
            f"{SUPABASE_URL}/rest/v1/voice_profiles",
            headers=_headers(),
            params={"user_id": f"eq.{user_id}"},
            timeout=15,
        )
        res.raise_for_status()


async def record_event(user_id: Optional[str], event: str, ok: bool = True, meta: Optional[dict] = None) -> None:
    """Log what someone did. Never let this break the thing they were doing."""
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{SUPABASE_URL}/rest/v1/events",
                headers={**_headers(), "Prefer": "return=minimal"},
                json=[{"user_id": user_id, "event": event[:60], "ok": ok, "meta": meta or {}}],
                timeout=8,
            )
    except Exception:
        pass


async def read_usage(days: int = 30) -> dict:
    """Counts for the owner dashboard: signups, what people did, and where it failed."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/events",
            headers=_headers(),
            params={"created_at": f"gte.{since}", "select": "user_id,event,ok,meta,created_at", "order": "created_at.desc", "limit": "5000"},
            timeout=20,
        )
        res.raise_for_status()
        rows = res.json()
    return {"rows": rows, "days": days}
