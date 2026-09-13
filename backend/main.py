from typing import Optional, List
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from fastapi.concurrency import run_in_threadpool
from crawler import crawl_reddit, search_many, search_web, research_reddit_with_review, verified_reddit_threads
from extractors import extract_intel
from generator import draft_post, draft_comment, generate_question_batch, generate_question_answer, plan_queries, answer_from_threads, validate_question_answer, evaluate_question_sources
from graph import ingest_threads, link_user_to_threads, read_graph
from search_console import parse_gsc
import gsc_patterns, gsc_store
from topics import tag_threads
import composio_reddit
import os, re, httpx, logging, json
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


@app.post("/reddit/connect")
async def reddit_connect(
    user_id: Optional[str] = Depends(require_user),
    origin: Optional[str] = Header(None),
):
    """Hand back a Composio sign-in page for this person to open."""
    try:
        link = await composio_reddit.create_connect_link(user_id, origin)
        # Only mark it pending if this is genuinely a new connection. Reconnecting
        # an already-working account must not knock it out of service.
        existing = await composio_reddit.read_connection(user_id)
        if not existing or existing.get("connected_account_id") != link["connected_account_id"]:
            await composio_reddit.save_connection(user_id, link["connected_account_id"], "pending")
        return link
    except composio_reddit.NotConfigured:
        raise HTTPException(status_code=503, detail="Reddit connecting is not set up yet.")
    except Exception:
        logger.exception("Could not start Reddit connecting")
        raise HTTPException(status_code=502, detail="Could not reach Reddit right now. Please try again.")


@app.get("/reddit/status")
async def reddit_status(user_id: Optional[str] = Depends(require_user)):
    """Whether this person's Reddit is connected, and who they are on Reddit."""
    try:
        saved = await composio_reddit.read_connection(user_id)
        if not saved:
            return {"connected": False}

        live = await composio_reddit.connection_status(saved["connected_account_id"])

        # Composio says ACTIVE the moment the person finishes signing in.
        # Always bring our own record up to match, because pressing Connect a
        # second time writes "pending" and would otherwise leave a working
        # connection looking broken.
        if live == "ACTIVE":
            profile = None
            if not saved.get("reddit_username"):
                profile = await composio_reddit.get_profile(saved["connected_account_id"])
            if profile or saved.get("status") != "active":
                await composio_reddit.save_connection(
                    user_id, saved["connected_account_id"], "active", profile
                )
                saved = await composio_reddit.read_connection(user_id) or saved
        elif live in ("EXPIRED", "FAILED", "MISSING"):
            await composio_reddit.save_connection(
                user_id, saved["connected_account_id"], "expired"
            )

        return {
            "connected": live == "ACTIVE",
            "state": live,
            "username": saved.get("reddit_username"),
            "karma": (saved.get("meta") or {}).get("karma"),
            "last_synced_at": saved.get("last_synced_at"),
        }
    except composio_reddit.NotConfigured:
        raise HTTPException(status_code=503, detail="Reddit connecting is not set up yet.")
    except Exception:
        logger.exception("Could not check the Reddit connection")
        raise HTTPException(status_code=502, detail="Could not check your Reddit connection.")


@app.post("/reddit/sync")
async def reddit_sync(user_id: Optional[str] = Depends(require_user)):
    """Pull this person's own Reddit posts into their graph. Read only."""
    saved = await composio_reddit.read_connection(user_id)
    if not saved or saved.get("status") != "active":
        raise HTTPException(status_code=400, detail="Connect your Reddit account first.")

    username = saved.get("reddit_username")
    if not username:
        profile = await composio_reddit.get_profile(saved["connected_account_id"])
        username = (profile or {}).get("username")
        if username:
            await composio_reddit.save_connection(
                user_id, saved["connected_account_id"], "active", profile
            )
    if not username:
        raise HTTPException(status_code=502, detail="Could not read your Reddit username.")

    try:
        posts = await composio_reddit.get_own_posts(user_id, username)
        if not posts:
            return {"added": 0, "username": username}

        node_ids = await ingest_threads(posts)
        if node_ids:
            await link_user_to_threads(user_id, list(node_ids.values()), "authored")
            await tag_threads(user_id, posts, node_ids)
        await composio_reddit.mark_synced(user_id)
        return {"added": len(node_ids), "username": username}
    except Exception:
        logger.exception("Could not pull this person's Reddit posts")
        raise HTTPException(status_code=502, detail="Could not read your Reddit posts right now.")


class SaveToGraphRequest(BaseModel):
    threads: List[dict] = []   # anything with a reddit permalink or url


@app.post("/graph/save")
async def graph_save(req: SaveToGraphRequest, user_id: Optional[str] = Depends(require_user)):
    """
    Mark threads as saved by this person, so they show under Saved on the graph.
    Called when something goes onto the Board. Safe to call twice.
    """
    if not req.threads:
        return {"added": 0}
    try:
        node_ids = await ingest_threads(req.threads)
        if not node_ids:
            return {"added": 0}
        await link_user_to_threads(user_id, list(node_ids.values()), "saved")
        await tag_threads(user_id, req.threads, node_ids)
        return {"added": len(node_ids)}
    except Exception:
        logger.exception("Could not save threads to the graph")
        raise HTTPException(status_code=500, detail="Could not save that to your graph.")


@app.get("/graph")
async def graph(user_id: Optional[str] = Depends(get_current_user)):
    """Nodes and links for the signed-in person's graph. Signed out gets an empty one."""
    try:
        return await read_graph(user_id)
    except Exception:
        logger.exception("Graph read failed")
        raise HTTPException(status_code=500, detail="Could not load your graph. Please try again.")


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
async def ask(req: AskRequest, user_id: Optional[str] = Depends(get_current_user)):
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

    # Feed the graph. The answer is already made, so a failure here must never
    # break the reply the person is waiting for.
    try:
        node_ids = await ingest_threads(threads)
        if user_id and node_ids:
            await link_user_to_threads(user_id, list(node_ids.values()), "cited")
            await tag_threads(user_id, threads, node_ids)
    except Exception:
        logger.exception("Graph write failed after ask")

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
async def question_answer(req: QuestionAnswerRequest):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    # Look it up first, so the answer comes from sources rather than memory.
    # If the search fails we still answer, but the reply says it is unsourced.
    results, validation = [], {"checked": 0, "verified": 0, "communities": 0, "retried": False, "passed": False}
    try:
        results, validation = await research_reddit_with_review(req.question)
    except Exception:
        logger.exception("Web search failed, answering without sources")

    try:
        answer = await run_in_threadpool(generate_question_answer, req.brief, req.question, results)
        answer_review = validate_question_answer(answer["answer"], answer.get("claims", []), len(results))
        attempts = [{"stage": "research", "passed": validation["passed"], "retried": validation["retried"]}, {"stage": "answer", "passed": answer_review["passed"]}]
        if results and not answer_review["passed"]:
            feedback = "Each factual claim needs valid source IDs and every source ID must appear as a matching [S1] citation."
            answer = await run_in_threadpool(generate_question_answer, req.brief, req.question, results, feedback)
            answer_review = validate_question_answer(answer["answer"], answer.get("claims", []), len(results))
            attempts.append({"stage": "answer correction", "passed": answer_review["passed"]})
        answer["validation"] = validation
        answer["run"] = {"passed": validation["passed"] and answer_review["passed"], "claims": answer_review["claims"], "attempts": attempts}
        return answer
    except Exception:
        logger.exception("Question answer generation failed")
        raise HTTPException(status_code=500, detail="Answer generation failed. Please try again.")


def _question_event(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _question_checks(validation: dict, answer_review: dict) -> list[dict]:
    return [
        {
            "label": "Source relevance",
            "passed": validation["score"] >= 60 and validation["verified"] >= 3,
            "detail": f"Evidence score {validation['score']}/100 from {validation['verified']} relevant threads",
        },
        {
            "label": "Community diversity",
            "passed": validation["communities"] >= 2,
            "detail": f"Evidence comes from {validation['communities']} communities",
        },
        {
            "label": "Question coverage",
            "passed": validation["coverage"] >= 70,
            "detail": f"Sources cover {validation['coverage']}% of the question",
        },
        {
            "label": "Claim citations",
            "passed": answer_review["passed"],
            "detail": (
                f"{answer_review['claim_count']} claims mapped to {answer_review['cited_sources']} sources"
                if answer_review["passed"]
                else f"{answer_review['invalid_claims']} invalid claims, {len(answer_review['invalid_citations'])} invalid citations, and {len(answer_review['unmapped_citations'])} unmapped citations"
            ),
        },
    ]


@app.post("/question-answer-stream")
async def question_answer_stream(req: QuestionAnswerRequest):
    """Run a question while reporting each real research and correction stage."""
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    async def events():
        try:
            yield _question_event({"type": "stage", "stage": "research", "status": "active", "detail": "Searching Reddit"})
            initial = await search_web(req.question, limit=6, reddit_only=True)
            yield _question_event({"type": "stage", "stage": "research", "status": "passed", "detail": f"{len(initial)} sources found"})

            yield _question_event({"type": "stage", "stage": "validate", "status": "active", "detail": "Scoring source relevance"})
            candidates = verified_reddit_threads(initial)
            evidence = await run_in_threadpool(evaluate_question_sources, req.question, candidates)
            retried = not evidence["passed"]

            if retried:
                yield _question_event({"type": "stage", "stage": "validate", "status": "review", "detail": f"Evidence score {evidence['score']}/100; refining research"})
                yield _question_event({"type": "stage", "stage": "research", "status": "active", "detail": "Running a focused second search"})
                retry = await search_web(f"{req.question} experience discussion", limit=6, reddit_only=True)
                candidates = verified_reddit_threads(initial + retry)
                evidence = await run_in_threadpool(evaluate_question_sources, req.question, candidates)

            results = evidence["relevant"][:6]
            validation = {
                "checked": len(initial) + (6 if retried else 0),
                "verified": len(results),
                "communities": evidence["communities"],
                "score": evidence["score"],
                "coverage": evidence["coverage"],
                "retried": retried,
                "passed": evidence["passed"],
            }
            yield _question_event({
                "type": "stage",
                "stage": "research",
                "status": "passed" if results else "review",
                "detail": f"{len(results)} relevant threads across {validation['communities']} communities",
            })
            yield _question_event({
                "type": "stage",
                "stage": "validate",
                "status": "passed" if validation["passed"] else "review",
                "detail": f"Evidence score {validation['score']}/100" + (" · passed" if validation["passed"] else " · needs review"),
            })

            yield _question_event({"type": "stage", "stage": "answer", "status": "active", "detail": "Mapping claims to sources"})
            if results:
                answer = await run_in_threadpool(generate_question_answer, req.brief, req.question, results)
            else:
                answer = {
                    "answer": "I couldn't find relevant Reddit evidence for this question, so I can't give a supported answer yet.",
                    "claims": [],
                    "sources": [],
                    "sourced": False,
                }
            answer_review = validate_question_answer(answer["answer"], answer.get("claims", []), len(results))
            attempts = [
                {"stage": "research", "passed": validation["passed"], "retried": validation["retried"]},
                {"stage": "answer", "passed": answer_review["passed"]},
            ]
            yield _question_event({
                "type": "stage",
                "stage": "answer",
                "status": "passed" if answer_review["passed"] else "review",
                "detail": f"{len(answer_review['claims'])} source-backed claims mapped",
            })

            if results and not answer_review["passed"]:
                yield _question_event({"type": "stage", "stage": "correct", "status": "active", "detail": "Correcting unsupported citations"})
                feedback = "Every factual claim needs valid source IDs, every source ID must appear as a matching [S1] citation, and every citation in the answer must be represented in the claims map."
                answer = await run_in_threadpool(generate_question_answer, req.brief, req.question, results, feedback)
                answer_review = validate_question_answer(answer["answer"], answer.get("claims", []), len(results))
                attempts.append({"stage": "answer correction", "passed": answer_review["passed"]})
                yield _question_event({
                    "type": "stage",
                    "stage": "correct",
                    "status": "passed" if answer_review["passed"] else "review",
                    "detail": "Corrected answer passed" if answer_review["passed"] else "Answer still needs review",
                })
            elif answer_review["passed"]:
                yield _question_event({"type": "stage", "stage": "correct", "status": "passed", "detail": "No correction needed"})
            else:
                yield _question_event({"type": "stage", "stage": "correct", "status": "review", "detail": "Answer withheld: no relevant evidence"})

            answer["validation"] = validation
            answer["run"] = {
                "passed": validation["passed"] and answer_review["passed"],
                "claims": answer_review["claims"],
                "attempts": attempts,
                "checks": _question_checks(validation, answer_review),
            }
            yield _question_event({"type": "result", "data": answer})
        except Exception:
            logger.exception("Streaming question answer failed")
            yield _question_event({"type": "error", "message": "Answer generation failed. Please try again."})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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


# --- Search Console -------------------------------------------------------
class GscImportRequest(BaseModel):
    content: str
    site_url: Optional[str] = None


class GscPatternRequest(BaseModel):
    name: str
    pattern: str
    intent_class: str = "question"


@app.post("/gsc/import")
async def gsc_import(req: GscImportRequest, user_id: str = Depends(require_user)):
    """Parse an uploaded Search Console CSV and store it."""
    try:
        parsed = await run_in_threadpool(parse_gsc, req.content)
    except ValueError as exc:
        # These messages are written for the person who uploaded the file.
        raise HTTPException(status_code=400, detail=str(exc))

    import_id = await gsc_store.create_import(user_id, parsed, req.site_url)
    return {
        "import_id": import_id,
        "key_kind": parsed["key_kind"],
        "row_count": parsed["row_count"],
        "columns_found": parsed["columns_found"],
        "warnings": parsed["warnings"],
    }


@app.get("/gsc/imports")
async def gsc_imports(user_id: str = Depends(require_user)):
    return {"imports": await gsc_store.list_imports(user_id)}


@app.get("/gsc/analyse")
async def gsc_analyse(
    import_id: Optional[str] = None,
    limit: Optional[int] = 100,
    sort_by: str = "impressions",
    user_id: str = Depends(require_user),
):
    """
    Score and bucket one import.

    `limit` is the slice shown by default; 0 means the whole file. Counts in
    the response say which slice they came from, so a top-100 number is never
    read as a whole-file number.
    """
    if sort_by not in {"impressions", "clicks", "position", "ctr"}:
        raise HTTPException(status_code=400, detail="sort_by must be impressions, clicks, position or ctr")

    rows, key_kind = await gsc_store.read_rows(user_id, import_id)
    if not rows:
        return {"rows": [], "total_rows": 0, "key_kind": None}

    saved = await gsc_store.list_patterns(user_id)
    extra = [(p["name"], p["pattern"], p.get("intent_class") or "question") for p in saved]

    return await run_in_threadpool(
        gsc_patterns.analyse, rows, key_kind, extra, (limit or None), sort_by
    )


@app.get("/gsc/patterns")
async def gsc_list_patterns(user_id: str = Depends(require_user)):
    return {
        "defaults": [
            {"name": n, "pattern": p, "intent_class": k}
            for n, p, k in gsc_patterns.DEFAULT_PATTERNS
        ],
        "saved": await gsc_store.list_patterns(user_id),
    }


@app.post("/gsc/patterns")
async def gsc_save_pattern(req: GscPatternRequest, user_id: str = Depends(require_user)):
    try:
        gsc_patterns.validate_pattern(req.pattern)
    except gsc_patterns.PatternError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if req.intent_class not in gsc_patterns.INTENT_WEIGHT:
        raise HTTPException(
            status_code=400,
            detail="intent_class must be one of " + ", ".join(gsc_patterns.INTENT_WEIGHT),
        )
    return await gsc_store.save_pattern(user_id, req.name, req.pattern, req.intent_class)


@app.delete("/gsc/patterns/{pattern_id}")
async def gsc_delete_pattern(pattern_id: str, user_id: str = Depends(require_user)):
    await gsc_store.delete_pattern(user_id, pattern_id)
    return {"deleted": pattern_id}


@app.post("/gsc/patterns/test")
async def gsc_test_pattern(req: GscPatternRequest, import_id: Optional[str] = None,
                           user_id: str = Depends(require_user)):
    """How many rows a pattern matches, before it gets saved."""
    try:
        gsc_patterns.validate_pattern(req.pattern)
    except gsc_patterns.PatternError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    rows, _ = await gsc_store.read_rows(user_id, import_id)
    matcher = re.compile(req.pattern, re.IGNORECASE)
    matches = [r["key"] for r in rows if matcher.search(r["key"])]
    return {
        "matched": len(matches),
        "of": len(rows),
        "examples": matches[:10],
    }
