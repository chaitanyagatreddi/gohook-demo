"""
Topics — reads a thread and pulls out what it is about.

Topics belong to a person, not to everyone, so they live in user_nodes and the
links from a thread to a topic live in user_edges.

A thread is only ever read once per person. If the link already exists, the
model is never called again for it.
"""
import json
import logging
import os
from typing import Optional

import httpx
from dotenv import load_dotenv

from generator import get_client

load_dotenv()
logger = logging.getLogger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

MODEL = "gpt-4o-mini"
MAX_THREADS_PER_ASK = 12   # keeps the cost per question predictable
MAX_TOPICS_PER_THREAD = 5

SYSTEM_PROMPT = """You label Reddit threads with the things they are about.

Return 2 to 5 labels per thread. A label is a product, a company, a problem, or
a subject people are discussing — "notion", "pricing", "ai credits", "churn".

Rules:
- lowercase, one to three words
- singular, not plural: "price" not "prices"
- no punctuation, no hashtags
- prefer the common word over a clever one
- skip generic filler like "question", "help", "discussion", "reddit"

Return JSON only, shaped: {"topics": ["...", "..."]}"""


def _headers() -> dict:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    return {
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
    }


def extract_topics(title: str, body: str) -> list[str]:
    """Ask the model what one thread is about. Returns [] if anything goes wrong."""
    text = f"Title: {title}\n\n{body}".strip()[:2000]
    if not text:
        return []
    try:
        res = get_client().chat.completions.create(
            model=MODEL,
            response_format={"type": "json_object"},
            temperature=0,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
        )
        raw = json.loads(res.choices[0].message.content or "{}")
    except Exception:
        logger.exception("Topic extraction failed")
        return []

    topics = []
    for t in raw.get("topics", [])[:MAX_TOPICS_PER_THREAD]:
        if not isinstance(t, str):
            continue
        label = " ".join(t.lower().split())
        if 1 <= len(label) <= 40:
            topics.append(label)
    # keep order, drop repeats
    return list(dict.fromkeys(topics))


async def _already_done(client: httpx.AsyncClient, user_id: str, node_ids: list[str]) -> set:
    """Thread ids this person already has topics for, so we never pay twice."""
    if not node_ids:
        return set()
    res = await client.get(
        f"{SUPABASE_URL}/rest/v1/user_edges",
        headers=_headers(),
        params={
            "user_id": f"eq.{user_id}",
            "type": "eq.mentions",
            "from_id": f"in.({','.join(node_ids)})",
            "select": "from_id",
        },
        timeout=30,
    )
    res.raise_for_status()
    return {row["from_id"] for row in res.json()}


async def _upsert_topics(client: httpx.AsyncClient, user_id: str, labels: list[str]) -> dict:
    """Make sure each topic exists for this person. Returns label -> id."""
    if not labels:
        return {}
    rows = [{"user_id": user_id, "type": "topic", "label": label} for label in labels]
    res = await client.post(
        f"{SUPABASE_URL}/rest/v1/user_nodes",
        headers={**_headers(), "Prefer": "resolution=merge-duplicates,return=representation"},
        params={"on_conflict": "user_id,type,label"},
        json=rows,
        timeout=30,
    )
    res.raise_for_status()
    return {r["label"]: r["id"] for r in res.json()}


async def tag_threads(user_id: Optional[str], threads: list[dict], node_ids: dict) -> int:
    """
    Give this person's threads their topics.

    `threads` are the search results, `node_ids` maps Reddit thread id -> node id
    (what ingest_threads handed back). Returns how many threads were newly tagged.
    """
    if not user_id or not threads or not node_ids:
        return 0

    from graph import thread_id_from_permalink  # imported here to avoid a circular import

    # Pair each thread with its saved node id.
    pairs = []
    for t in threads:
        rid = thread_id_from_permalink(t.get("permalink") or t.get("url") or "")
        if rid and rid in node_ids:
            pairs.append((node_ids[rid], t))

    if not pairs:
        return 0

    async with httpx.AsyncClient() as client:
        done = await _already_done(client, user_id, [nid for nid, _ in pairs])
        todo = [(nid, t) for nid, t in pairs if nid not in done][:MAX_THREADS_PER_ASK]
        if not todo:
            return 0

        # One model call per thread, run together rather than one after another.
        import asyncio
        results = await asyncio.gather(*[
            asyncio.to_thread(extract_topics, t.get("title", ""), t.get("selftext", ""))
            for _, t in todo
        ])

        every_label = sorted({label for labels in results for label in labels})
        if not every_label:
            return 0

        topic_ids = await _upsert_topics(client, user_id, every_label)

        edges = []
        for (node_id, _), labels in zip(todo, results):
            for label in labels:
                if label in topic_ids:
                    edges.append({
                        "user_id": user_id,
                        "from_table": "nodes",
                        "from_id": node_id,
                        "to_table": "user_nodes",
                        "to_id": topic_ids[label],
                        "type": "mentions",
                    })

        if edges:
            res = await client.post(
                f"{SUPABASE_URL}/rest/v1/user_edges",
                headers={**_headers(), "Prefer": "resolution=ignore-duplicates,return=minimal"},
                params={"on_conflict": "user_id,from_table,from_id,to_table,to_id,type"},
                json=edges,
                timeout=30,
            )
            res.raise_for_status()

    return len(todo)
