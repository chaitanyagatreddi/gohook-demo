from typing import Optional, List
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from fastapi.concurrency import run_in_threadpool
from crawler import crawl_reddit, search_many
from extractors import extract_intel
from generator import draft_post, draft_comment, generate_question_batch, generate_question_answer, plan_queries, answer_from_threads
import os, re, httpx, logging
from fastapi import Header, Depends
from dotenv import load_dotenv
load_dotenv()

logger = logging.getLogger(__name__)

COMPARISON_PATTERN = re.compile(r"\bvs\.?\b|\bversus\b", re.IGNORECASE)

ZERNIO_API_KEY = os.getenv("ZERNIO_API_KEY")
ZERNIO_REDDIT_ACCOUNT_ID = os.getenv("ZERNIO_REDDIT_ACCOUNT_ID")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

RESEND_API_KEY = os.getenv("RESEND_API_KEY")
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET")

ONBOARDING_EMAIL_HTML = """
<p>Hey {name} \U0001F44B,</p>
<p>Welcome to <strong>Redditscan</strong> — Reddit, but focus mode: pricing, complaints, comparisons, no noise.</p>
<p><strong>Here's what you can do:</strong></p>
<ul>
  <li>\U0001F50D Search any comparison ("Notion vs Asana", "Linear vs Jira"...)</li>
  <li>\U0001F4B0 Get pricing, complaints, comparisons, and praise — ranked, sourced</li>
  <li>✍️ Draft a Reddit-style post or comment that sounds human</li>
  <li>\U0001F4C5 Schedule straight to Reddit via Zernio</li>
</ul>
<p>Just enter a comparison and hit <strong>Scan</strong>. Results in seconds. ⚡</p>
<p>
  <a href="https://redditscan.vercel.app"
     style="display:inline-block;background-color:#ff4500;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">
    Open Redditscan &rarr;
  </a>
</p>
<p>&mdash; Chaitanya</p>
"""


async def send_onboarding_email(to_email: str):
    if not RESEND_API_KEY:
        logger.error("RESEND_API_KEY not set, skipping onboarding email")
        return
    name = to_email.split("@")[0]
    async with httpx.AsyncClient() as client:
        res = await client.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "from": "Redditscan <onboarding@resend.dev>",
                "to": [to_email],
                "subject": "Welcome to Redditscan — You're In!",
                "html": ONBOARDING_EMAIL_HTML.format(name=name),
            },
            timeout=10,
        )
    if res.status_code >= 400:
        logger.error(f"Resend send failed: {res.status_code} {res.text[:500]}")


async def get_current_user(authorization: Optional[str] = Header(None)):
    """Returns Supabase user_id from a Bearer access token, or None if absent (local-dev fallback)."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.removeprefix("Bearer ")
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={"Authorization": f"Bearer {token}", "apikey": SUPABASE_ANON_KEY},
            timeout=10,
        )
    if res.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid or expired session. Please sign in again.")
    return res.json()["id"]


async def require_user(authorization: Optional[str] = Header(None)):
    """Same as get_current_user but always requires a valid session."""
    if not authorization:
        raise HTTPException(status_code=401, detail="Please sign in first.")
    return await get_current_user(authorization)


async def get_zernio_credentials(user_id: Optional[str]):
    """Per-user Zernio credentials from Supabase if authenticated, else env vars for local dev."""
    if user_id is None:
        if not ZERNIO_API_KEY or not ZERNIO_REDDIT_ACCOUNT_ID:
            raise HTTPException(status_code=500, detail="Zernio not configured")
        return ZERNIO_API_KEY, ZERNIO_REDDIT_ACCOUNT_ID

    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{SUPABASE_URL}/rest/v1/zernio_connections",
            params={"user_id": f"eq.{user_id}", "select": "zernio_api_key,zernio_account_id"},
            headers={
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
            },
            timeout=10,
        )
    rows = res.json()
    if not rows:
        raise HTTPException(status_code=400, detail="Connect your Zernio account first.")
    return rows[0]["zernio_api_key"], rows[0]["zernio_account_id"]

app = FastAPI(title="Redditscan API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://gohooklive.vercel.app",
        "https://gohooklive-git-staging-chaitanya-s-projects93.vercel.app",
        "https://redditscan.vercel.app",
        "https://redditscan-git-staging-chaitanya-s-projects93.vercel.app",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SearchRequest(BaseModel):
    query: str
    subreddits: List[str] = ["SaaS", "entrepreneur", "productivity", "startups"]
    expand: bool = False  # run extra Serper queries for broader coverage


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/webhooks/new-user")
async def new_user_webhook(payload: dict, x_webhook_secret: Optional[str] = Header(None)):
    if not WEBHOOK_SECRET or x_webhook_secret != WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    email = payload.get("record", {}).get("email")
    if not email:
        raise HTTPException(status_code=400, detail="No email in payload")

    await send_onboarding_email(email)
    return {"sent": True}


@app.post("/search")
async def search(req: SearchRequest):
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    posts = await crawl_reddit(req.query, req.subreddits, expand=req.expand)

    if not posts:
        raise HTTPException(status_code=404, detail="No Reddit posts found")

    intel = extract_intel(posts, req.query)
    intel["query"] = req.query
    intel["subreddits_searched"] = req.subreddits
    intel["total_posts_scanned"] = len(posts)
    intel["expanded"] = req.expand

    return intel


class AskRequest(BaseModel):
    question: str
    history: List[dict] = []  # prior turns: [{role, content}]
    sources: List[dict] = []  # threads from earlier turns, reused on follow-ups


@app.post("/ask")
async def ask(req: AskRequest):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")
    try:
        plan = await run_in_threadpool(plan_queries, req.question)
        fresh = await search_many(plan["queries"], limit=20)

        # Earlier threads first so their [n] numbers stay stable across follow-ups
        threads, seen = [], set()
        for t in req.sources + fresh:
            key = (t.get("permalink") or t.get("url", "")).split("?")[0].rstrip("/")
            if key and key not in seen:
                seen.add(key)
                threads.append(t)
        threads = threads[:20]

        if not threads:
            raise HTTPException(status_code=404, detail="No Reddit threads found for that question. Try rephrasing.")

        answer = await run_in_threadpool(answer_from_threads, req.question, threads, req.history)
    except HTTPException:
        raise
    except Exception:
        logger.exception("Ask failed")
        raise HTTPException(status_code=500, detail="Could not answer that. Please try again.")

    return {
        "answer": answer,
        "intent": plan["intent"],
        "queries_used": plan["queries"],
        "sources": [
            {
                "n": i,
                "title": t.get("title", ""),
                "subreddit_name_prefixed": t.get("subreddit_name_prefixed", ""),
                "selftext": t.get("selftext", ""),
                "permalink": t.get("permalink", ""),
                "url": t.get("url", ""),
            }
            for i, t in enumerate(threads, 1)
        ],
    }


class DraftRequest(BaseModel):
    idea: str
    context_snippets: Optional[List[str]] = None
    style: str = "reddit"  # "reddit" | "hn" | "pg"


class QuestionBatchRequest(BaseModel):
    brief: str


class QuestionAnswerRequest(BaseModel):
    brief: str = ""
    question: str


@app.post("/question-batch")
def question_batch(req: QuestionBatchRequest):
    if not req.brief.strip():
        raise HTTPException(status_code=400, detail="Brief cannot be empty")
    try:
        return generate_question_batch(req.brief)
    except Exception:
        logger.exception("Question batch generation failed")
        raise HTTPException(status_code=500, detail="Question batch generation failed. Please try again.")


@app.post("/question-answer")
def question_answer(req: QuestionAnswerRequest):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")
    try:
        return generate_question_answer(req.brief, req.question)
    except Exception:
        logger.exception("Question answer generation failed")
        raise HTTPException(status_code=500, detail="Answer generation failed. Please try again.")


@app.post("/draft")
def draft(req: DraftRequest):
    if not req.idea.strip():
        raise HTTPException(status_code=400, detail="Idea cannot be empty")
    try:
        return draft_post(req.idea, req.context_snippets, style=req.style)
    except Exception:
        logger.exception("Draft generation failed")
        raise HTTPException(status_code=500, detail="Draft generation failed. Please try again.")


class CommentRequest(BaseModel):
    post: str    # the Reddit post being replied to
    intent: str  # what the user wants to say


@app.post("/comment")
def comment(req: CommentRequest):
    if not req.post.strip() or not req.intent.strip():
        raise HTTPException(status_code=400, detail="Post and intent cannot be empty")
    try:
        return draft_comment(req.post, req.intent)
    except Exception:
        logger.exception("Comment generation failed")
        raise HTTPException(status_code=500, detail="Comment generation failed. Please try again.")


class ZernioConnectRequest(BaseModel):
    zernio_api_key: str


@app.post("/zernio/connect")
async def zernio_connect(req: ZernioConnectRequest, user_id: str = Depends(require_user)):
    async with httpx.AsyncClient() as client:
        res = await client.get(
            "https://zernio.com/api/v1/accounts",
            params={"platform": "reddit", "status": "connected"},
            headers={"Authorization": f"Bearer {req.zernio_api_key}"},
            timeout=10,
        )
    if res.status_code != 200:
        raise HTTPException(status_code=400, detail="Invalid Zernio API key. Please check and try again.")

    accounts = res.json().get("accounts", [])
    if not accounts:
        raise HTTPException(status_code=400, detail="No Reddit account connected to this Zernio key. Connect one in your Zernio dashboard first.")

    account_id = accounts[0].get("_id")

    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{SUPABASE_URL}/rest/v1/zernio_connections",
            params={"on_conflict": "user_id"},
            json={"user_id": user_id, "zernio_api_key": req.zernio_api_key, "zernio_account_id": account_id},
            headers={
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates",
            },
            timeout=10,
        )
    if res.status_code not in (200, 201):
        logger.error(f"Supabase upsert failed: {res.status_code} {res.text[:500]}")
        raise HTTPException(status_code=500, detail="Could not save Zernio connection. Please try again.")

    return {"connected": True, "account_id": account_id}


@app.get("/subreddits")
async def subreddits(user_id: Optional[str] = Depends(get_current_user)):
    zernio_api_key, zernio_account_id = await get_zernio_credentials(user_id)
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"https://zernio.com/api/v1/accounts/{zernio_account_id}/reddit-subreddits",
            headers={"Authorization": f"Bearer {zernio_api_key}"},
            timeout=10,
        )
    if res.status_code != 200:
        logger.error(f"Zernio subreddits fetch failed: {res.status_code} {res.text[:500]}")
        raise HTTPException(status_code=502, detail="Could not fetch subreddits from Zernio. Check your connection.")
    data = res.json()
    return [s["name"] for s in data.get("subreddits", []) if not s["name"].startswith("u_")]


class ScheduleRequest(BaseModel):
    content: str
    subreddit: str
    title: Optional[str] = None
    scheduled_for: Optional[str] = None  # ISO 8601, e.g. "2026-06-02T09:00:00.000Z"


@app.post("/schedule")
async def schedule(req: ScheduleRequest, user_id: Optional[str] = Depends(get_current_user)):
    zernio_api_key, zernio_account_id = await get_zernio_credentials(user_id)
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="Content cannot be empty")

    payload = {
        "content": req.content,
        "platforms": [{
            "platform": "reddit",
            "accountId": zernio_account_id,
            "options": {
                "subreddit": req.subreddit.lstrip("r/"),
                "title": req.title or req.content[:100],
            }
        }],
    }
    if req.scheduled_for:
        payload["scheduledFor"] = req.scheduled_for

    async with httpx.AsyncClient() as client:
        res = await client.post(
            "https://zernio.com/api/v1/posts",
            json=payload,
            headers={
                "Authorization": f"Bearer {zernio_api_key}",
                "Content-Type": "application/json",
            },
            timeout=15,
        )

    logger.info(f"Zernio schedule status: {res.status_code}")

    if res.status_code not in (200, 201):
        logger.error(f"Zernio schedule failed: {res.status_code} {res.text[:500]}")
        raise HTTPException(status_code=502, detail="Could not schedule post via Zernio. Please check your connection and try again.")

    data = res.json()
    post = data.get("post", data)
    return {
        "post_id": post.get("_id") or post.get("id", ""),
        "status": post.get("status", "scheduled"),
        "scheduled_for": req.scheduled_for,
        "subreddit": req.subreddit,
    }
