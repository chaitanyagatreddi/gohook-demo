"""
Search Console storage — imports, rows and saved patterns, per user.

Same approach as graph.py: Supabase REST with the service role key, and
user_id written on every row so row-level security can do its job.
"""
import os
from typing import Optional

import httpx
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

# A single GSC export is 1,000 rows from the UI. The cap is here so a
# hand-built file cannot fill the free Supabase plan in one upload.
MAX_ROWS_PER_IMPORT = 5000
ROW_CHUNK = 500


def _headers() -> dict:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    return {
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
    }


async def create_import(user_id: str, parsed: dict, site_url: Optional[str] = None) -> str:
    """Stores the import and its rows. Returns the import id."""
    rows = parsed["rows"][:MAX_ROWS_PER_IMPORT]

    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{SUPABASE_URL}/rest/v1/gsc_imports",
            headers={**_headers(), "Prefer": "return=representation"},
            json={
                "user_id": user_id,
                "source": parsed.get("source", "csv"),
                "site_url": site_url,
                "key_kind": parsed["key_kind"],
                "row_count": len(rows),
            },
            timeout=30,
        )
        res.raise_for_status()
        import_id = res.json()[0]["id"]

        for start in range(0, len(rows), ROW_CHUNK):
            chunk = [
                {
                    "import_id": import_id,
                    "user_id": user_id,
                    "key": r["key"][:500],
                    "clicks": r.get("clicks"),
                    "impressions": r.get("impressions"),
                    "ctr": r.get("ctr"),
                    "position": r.get("position"),
                }
                for r in rows[start:start + ROW_CHUNK]
            ]
            res = await client.post(
                f"{SUPABASE_URL}/rest/v1/gsc_rows",
                headers={**_headers(), "Prefer": "return=minimal"},
                json=chunk,
                timeout=60,
            )
            res.raise_for_status()

    return import_id


async def list_imports(user_id: str) -> list:
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/gsc_imports",
            headers=_headers(),
            params={
                "user_id": f"eq.{user_id}",
                "select": "id,source,site_url,key_kind,row_count,created_at",
                "order": "created_at.desc",
                "limit": "20",
            },
            timeout=30,
        )
        res.raise_for_status()
        return res.json()


async def read_rows(user_id: str, import_id: Optional[str] = None) -> tuple:
    """
    Returns (rows, key_kind). With no import_id, reads the newest import.
    Returns ([], None) when the user has never uploaded anything.
    """
    imports = await list_imports(user_id)
    if not imports:
        return [], None
    chosen = next((i for i in imports if i["id"] == import_id), imports[0])

    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/gsc_rows",
            headers=_headers(),
            params={
                "import_id": f"eq.{chosen['id']}",
                "user_id": f"eq.{user_id}",
                "select": "key,clicks,impressions,ctr,position",
                "limit": str(MAX_ROWS_PER_IMPORT),
            },
            timeout=60,
        )
        res.raise_for_status()
        return res.json(), chosen["key_kind"]


async def list_patterns(user_id: str) -> list:
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/gsc_patterns",
            headers=_headers(),
            params={
                "user_id": f"eq.{user_id}",
                "select": "id,name,pattern,intent_class,created_at",
                "order": "created_at.asc",
            },
            timeout=30,
        )
        res.raise_for_status()
        return res.json()


async def save_pattern(user_id: str, name: str, pattern: str, intent_class: str) -> dict:
    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{SUPABASE_URL}/rest/v1/gsc_patterns",
            headers={**_headers(), "Prefer": "return=representation"},
            json={
                "user_id": user_id,
                "name": name[:60],
                "pattern": pattern,
                "intent_class": intent_class,
            },
            timeout=30,
        )
        res.raise_for_status()
        return res.json()[0]


async def delete_pattern(user_id: str, pattern_id: str) -> None:
    async with httpx.AsyncClient() as client:
        res = await client.delete(
            f"{SUPABASE_URL}/rest/v1/gsc_patterns",
            headers=_headers(),
            params={"id": f"eq.{pattern_id}", "user_id": f"eq.{user_id}"},
            timeout=30,
        )
        res.raise_for_status()
