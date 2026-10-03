"""
Google Search Console connect for GoHook, read-only.

Adapted from GTM Predictor's google_oauth.py. Two differences:
  * The refresh token is encrypted and stored per user in Supabase
    (gsc_connections), not sealed into a browser cookie.
  * The pull is the MVP call: query + page, top 100 rows, last 3 months.

Google "Testing" mode: a test user's refresh token stops working 7 days after
consent. That surfaces as ReconnectNeeded, so the caller can mark the
connection needs_reconnect and show "Reconnect Google".
"""
import base64
import calendar
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import time
from typing import Optional
from urllib.parse import quote, urlencode

import httpx
from cryptography.fernet import Fernet, InvalidToken
from dotenv import load_dotenv

load_dotenv()

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
SITES_URL = "https://www.googleapis.com/webmasters/v3/sites"

STATE_TTL_SECONDS = 600
ROW_LIMIT = 100

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")


class OAuthError(Exception):
    """Anything the user needs told plainly rather than as a stack trace."""


class ReconnectNeeded(OAuthError):
    """Refresh token is dead (revoked, or the 7-day Testing-mode expiry)."""


# --- config ---------------------------------------------------------------

def _client() -> tuple:
    cid = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
    csec = (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()
    if not cid or not csec:
        raise OAuthError("Google sign-in is not configured on this deployment.")
    return cid, csec


def configured() -> bool:
    return bool((os.getenv("GOOGLE_CLIENT_ID") or "").strip()
                and (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()
                and (os.getenv("GSC_TOKEN_KEY") or "").strip())


# --- state (signed, short-lived) ---------------------------------------------

def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _state_secret() -> bytes:
    raw = (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()
    if not raw:
        raise OAuthError("Server is missing GOOGLE_CLIENT_SECRET.")
    return raw.encode()


def _sign(payload: bytes) -> str:
    mac = hmac.new(_state_secret(), payload, hashlib.sha256).digest()
    return f"{_b64e(payload)}.{_b64e(mac)}"


def _unsign(token: str) -> bytes:
    try:
        body, mac = token.split(".", 1)
    except ValueError:
        raise OAuthError("Malformed token.")
    payload = _b64d(body)
    expected = hmac.new(_state_secret(), payload, hashlib.sha256).digest()
    if not hmac.compare_digest(_b64d(mac), expected):
        raise OAuthError("Token signature does not match.")
    return payload


def make_state(user_id: str) -> str:
    """Signed, short-lived. Carries the user id, because Google's redirect back
    to the callback arrives without a GoHook session header."""
    return _sign(json.dumps({"u": user_id, "n": _b64e(os.urandom(12)), "t": int(time.time())}).encode())


def check_state(state: str) -> str:
    """Returns the user id the state was made for."""
    if not state:
        raise OAuthError("Missing state.")
    data = json.loads(_unsign(state))
    if time.time() - data.get("t", 0) > STATE_TTL_SECONDS:
        raise OAuthError("That sign-in link expired. Try connecting again.")
    if not data.get("u"):
        raise OAuthError("Malformed token.")
    return data["u"]


# --- token encryption -----------------------------------------------------------
# Fernet key lives in the GSC_TOKEN_KEY env var, never in the database. Lose the
# key and stored tokens cannot be read; users reconnect, no search data is lost.
# Make a key with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

def _fernet() -> Fernet:
    key = (os.getenv("GSC_TOKEN_KEY") or "").strip()
    if not key:
        raise OAuthError("Server is missing GSC_TOKEN_KEY.")
    try:
        return Fernet(key.encode())
    except ValueError:
        raise OAuthError("GSC_TOKEN_KEY is not a valid Fernet key.")


def encrypt_token(refresh_token: str) -> str:
    return _fernet().encrypt(refresh_token.encode()).decode()


def decrypt_token(blob: str) -> str:
    try:
        return _fernet().decrypt(blob.encode()).decode()
    except InvalidToken:
        raise ReconnectNeeded("Your Search Console connection could not be read. Connect again.")


# --- Google OAuth ------------------------------------------------------------------

def auth_url(redirect_uri: str, user_id: str) -> str:
    cid, _ = _client()
    return AUTH_URL + "?" + urlencode({
        "client_id": cid,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        # Without prompt=consent Google omits the refresh token on repeat
        # authorisations.
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": make_state(user_id),
    })


def exchange_code(code: str, redirect_uri: str) -> dict:
    """Returns {"refresh_token", "scope"}. Refuses if read access was not granted."""
    cid, csec = _client()
    r = httpx.post(TOKEN_URL, timeout=30, data={
        "code": code, "client_id": cid, "client_secret": csec,
        "redirect_uri": redirect_uri, "grant_type": "authorization_code",
    })
    if r.status_code != 200:
        raise OAuthError(f"Google rejected the sign-in ({r.status_code}).")
    body = r.json()
    granted = body.get("scope", "")
    # Users can untick individual permissions on the consent screen.
    if SCOPE not in granted.split():
        raise OAuthError("We need read access to Search Console to continue.")
    refresh = body.get("refresh_token")
    if not refresh:
        raise OAuthError("Google did not return a refresh token. Disconnect the app "
                         "in your Google account and connect again.")
    return {"refresh_token": refresh, "scope": granted}


def access_token(refresh_token: str) -> str:
    cid, csec = _client()
    r = httpx.post(TOKEN_URL, timeout=30, data={
        "refresh_token": refresh_token, "client_id": cid,
        "client_secret": csec, "grant_type": "refresh_token",
    })
    if r.status_code == 400 and "invalid_grant" in r.text:
        # Revoked, or the 7-day Testing-mode expiry.
        raise ReconnectNeeded("Your Search Console connection expired. Connect again.")
    if r.status_code != 200:
        raise OAuthError(f"Could not refresh Google access ({r.status_code}).")
    return r.json()["access_token"]


def list_sites(token: str) -> list:
    r = httpx.get(SITES_URL, headers={"Authorization": f"Bearer {token}"}, timeout=30)
    if r.status_code != 200:
        raise OAuthError(f"Could not list your Search Console properties ({r.status_code}).")
    return [
        {"url": e.get("siteUrl"), "permission": e.get("permissionLevel")}
        for e in r.json().get("siteEntry", [])
        if e.get("permissionLevel") != "siteUnverifiedUser"
    ]


# --- the MVP pull ---------------------------------------------------------------------

def _today_pt() -> dt.date:
    """Search Console dates are Pacific Time."""
    try:
        from zoneinfo import ZoneInfo
        return dt.datetime.now(ZoneInfo("America/Los_Angeles")).date()
    except Exception:
        return dt.datetime.utcnow().date()


def _minus_months(d: dt.date, months: int) -> dt.date:
    y, m = d.year, d.month - months
    while m < 1:
        m += 12
        y -= 1
    return dt.date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def query_top_rows(token: str, site_url: str, today: Optional[dt.date] = None) -> dict:
    """
    One searchAnalytics call: dimensions query + page, top 100 rows by clicks,
    last 3 months. Google returns rows sorted by clicks, highest first, so
    rank 1 is the most clicks. 100 query+page rows is not 100 queries: a query
    that shows on two pages fills two rows.
    """
    end = today or _today_pt()
    start = _minus_months(end, 3)
    r = httpx.post(
        f"{SITES_URL}/{quote(site_url, safe='')}/searchAnalytics/query",
        headers={"Authorization": f"Bearer {token}"}, timeout=60,
        json={
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "dimensions": ["query", "page"],
            "type": "web",
            "rowLimit": ROW_LIMIT,
            "dataState": "all",
        },
    )
    if r.status_code == 403:
        raise OAuthError("That account cannot read this property in Search Console.")
    if r.status_code == 429 or "quota" in r.text.lower():
        raise OAuthError("Google is busy. Try again in 15 minutes.")
    if r.status_code != 200:
        raise OAuthError(f"Search Console returned {r.status_code}.")

    rows = []
    for i, row in enumerate(r.json().get("rows", []), start=1):
        keys = row.get("keys") or ["", ""]
        rows.append({
            "rank": i,
            "query": keys[0],
            "page": keys[1] if len(keys) > 1 else "",
            "clicks": row.get("clicks"),
            "impressions": row.get("impressions"),
            "ctr": row.get("ctr"),
            "position": row.get("position"),
        })
    return {
        "site_url": site_url,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "row_count": len(rows),
        "rows": rows,
    }


# --- storage (Supabase REST, same approach as gsc_store.py) ---------------------------------
# Table gsc_connections: one row per user (unique user_id), columns
#   user_id, refresh_token_enc, scope, consented_at, status ('ok' | 'needs_reconnect').

def _headers() -> dict:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    return {
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
    }


async def save_connection(user_id: str, refresh_token: str, scope: str) -> None:
    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{SUPABASE_URL}/rest/v1/gsc_connections?on_conflict=user_id",
            headers={**_headers(), "Prefer": "resolution=merge-duplicates"},
            json={
                "user_id": user_id,
                "refresh_token_enc": encrypt_token(refresh_token),
                "scope": scope,
                "consented_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "status": "ok",
            },
            timeout=30,
        )
        res.raise_for_status()


async def load_refresh_token(user_id: str) -> str:
    """The decrypted refresh token, or ReconnectNeeded if there is none usable."""
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/gsc_connections",
            headers=_headers(),
            params={"user_id": f"eq.{user_id}", "select": "refresh_token_enc,status"},
            timeout=30,
        )
        res.raise_for_status()
        rows = res.json()
    if not rows or rows[0].get("status") != "ok":
        raise ReconnectNeeded("Connect Google Search Console first.")
    return decrypt_token(rows[0]["refresh_token_enc"])


async def mark_needs_reconnect(user_id: str) -> None:
    async with httpx.AsyncClient() as client:
        res = await client.patch(
            f"{SUPABASE_URL}/rest/v1/gsc_connections",
            headers=_headers(),
            params={"user_id": f"eq.{user_id}"},
            json={"status": "needs_reconnect"},
            timeout=30,
        )
        res.raise_for_status()


async def read_status(user_id: str) -> Optional[dict]:
    """{"status", "scope", "consented_at"} for this user, or None if never connected.
    Never returns the token."""
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/gsc_connections",
            headers=_headers(),
            params={"user_id": f"eq.{user_id}", "select": "status,scope,consented_at"},
            timeout=30,
        )
        res.raise_for_status()
        rows = res.json()
    return rows[0] if rows else None


ROW_CHUNK = 100


async def save_run(user_id: str, pull: dict, analysis: Optional[dict] = None, brand_name: Optional[str] = None) -> str:
    """
    Store one pull and its rows, with the scoring from gsc_run_score.analyse()
    when given. Returns the run id. The rows are kept so the
    weekly gate can be served without calling Google again. If the rows fail to
    save, the run is removed so there is never a run with missing rows.
    """
    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{SUPABASE_URL}/rest/v1/gsc_runs",
            headers={**_headers(), "Prefer": "return=representation"},
            json={
                "user_id": user_id,
                "site_url": pull["site_url"],
                "start_date": pull["start_date"],
                "end_date": pull["end_date"],
                "row_count": pull["row_count"],
                "brand_name": brand_name,
                "brand_regex": (analysis or {}).get("brand_regex"),
                "benchmark": (analysis or {}).get("benchmark"),
            },
            timeout=30,
        )
        res.raise_for_status()
        run_id = res.json()[0]["id"]
        try:
            rows = (analysis or {}).get("rows") or pull["rows"]
            for start in range(0, len(rows), ROW_CHUNK):
                chunk = [
                    {
                        "run_id": run_id,
                        "user_id": user_id,
                        "rank": r["rank"],
                        "query": (r["query"] or "")[:1000],
                        "page": (r["page"] or "")[:2000],
                        "clicks": r.get("clicks"),
                        "impressions": r.get("impressions"),
                        "ctr": r.get("ctr"),
                        "position": r.get("position"),
                        "word_count": r.get("word_count"),
                        "is_brand": r.get("is_brand", False),
                        "geo_flag": r.get("geo_flag", False),
                        "groups": r.get("groups", []),
                        "bucket": r.get("bucket"),
                        "target_bucket": r.get("target_bucket"),
                        "est_extra_clicks": r.get("est_extra_clicks"),
                        "low_data": r.get("low_data", False),
                        "action": r.get("action"),
                    }
                    for r in rows[start:start + ROW_CHUNK]
                ]
                ins = await client.post(
                    f"{SUPABASE_URL}/rest/v1/gsc_run_rows", headers=_headers(), json=chunk, timeout=30
                )
                ins.raise_for_status()
        except Exception:
            await client.delete(
                f"{SUPABASE_URL}/rest/v1/gsc_runs",
                headers=_headers(), params={"id": f"eq.{run_id}"}, timeout=30,
            )
            raise
    return run_id


_UUID = re.compile(r"^[0-9a-fA-F-]{36}$")


async def list_runs(user_id: str) -> list:
    """The person's latest runs, newest first. Never includes rows."""
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/gsc_runs",
            headers=_headers(),
            params={"user_id": f"eq.{user_id}", "order": "created_at.desc", "limit": "10",
                    "select": "id,site_url,brand_name,row_count,created_at"},
            timeout=30,
        )
        res.raise_for_status()
        return res.json()


async def read_run(user_id: str, run_id: str) -> Optional[dict]:
    """One run and all its stored rows, or None if it is not this person's."""
    if not _UUID.match(run_id or ""):
        return None
    async with httpx.AsyncClient() as client:
        run_res = await client.get(
            f"{SUPABASE_URL}/rest/v1/gsc_runs",
            headers=_headers(),
            params={"id": f"eq.{run_id}", "user_id": f"eq.{user_id}", "select": "*"},
            timeout=30,
        )
        run_res.raise_for_status()
        runs = run_res.json()
        if not runs:
            return None
        rows_res = await client.get(
            f"{SUPABASE_URL}/rest/v1/gsc_run_rows",
            headers=_headers(),
            params={"run_id": f"eq.{run_id}", "user_id": f"eq.{user_id}", "order": "rank.asc",
                    "limit": "100", "select": "*"},
            timeout=30,
        )
        rows_res.raise_for_status()
        return {"run": runs[0], "rows": rows_res.json()}
