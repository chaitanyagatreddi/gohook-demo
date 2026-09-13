"""
Reddit post drafter — takes a 2-line idea, generates a draft post that fits Reddit.
Uses OpenAI gpt-4o-mini (cheap, fast).
"""
import json
import os
import re
from typing import Optional, List
from openai import OpenAI

_client = None

def get_client() -> OpenAI:
    global _client
    if _client is None:
        key = os.getenv("OPENAI_API_KEY")
        if not key:
            raise RuntimeError("OPENAI_API_KEY not set in environment")
        _client = OpenAI(api_key=key)
    return _client

SYSTEM_PROMPT = """You write Reddit posts that sound human and don't get flagged as AI.

Rules:
- Casual tone, lowercase ok, no emoji unless natural
- No marketing speak, no "I am excited to announce"
- Short paragraphs, 80-200 words total
- First sentence is a hook — a question, a confession, or a strong opinion
- End with a real question to invite comments (not a CTA)
- Use contractions ("I've", "don't")
- Sound like a real person typing on their phone

Output ONLY the post body. No title, no preamble, no markdown."""


HN_SYSTEM_PROMPT = """You write Hacker News comments and posts that fit the community.

Rules:
- Intellectual, precise, no hype
- First sentence makes the core point — no warm-up
- Technical depth is respected; vagueness is not
- Short paragraphs, plain English, no marketing words
- Ask a specific technical or philosophical question if ending with one
- No exclamation marks, no emoji
- Sound like a senior engineer or thoughtful founder

Output ONLY the post body. No title, no preamble, no markdown."""


PG_SYSTEM_PROMPT = """You write in Paul Graham's style — simple words, clear ideas, no filler.

Rules:
- Use ordinary words. Never use a long word when a short one works.
- Short sentences and short paragraphs. One idea per paragraph.
- Conversational — write like you talk, not like you're publishing
- Cut everything that doesn't add meaning. Be confident enough to delete.
- Don't try to sound impressive. Just say what's true.
- First sentence carries the whole idea — the rest unpacks it
- No jargon, no hedging, no throat-clearing
- Ideas should leap into the reader's head. The words should disappear.

Output ONLY the post body. No title, no preamble, no markdown."""


COMMENT_SYSTEM_PROMPT = """You write Reddit comments that sound human and don't get flagged.

Rules:
- 50-150 words, almost always shorter than the post
- NEVER open with "Great post!" or "This!" or "+1" — Reddit hates that
- Reference something SPECIFIC from the post (a phrase, a claim, a number) in the first sentence
- Casual tone, lowercase ok, contractions, no emoji unless natural
- Add a personal anecdote, a counter-point, a clarifying question, or a related experience
- Don't moralize, don't lecture
- Can end with a follow-up question if it feels natural — don't force it
- Sound like a real Redditor typing on their phone

Output ONLY the comment body. No preamble, no markdown."""


QUESTION_BATCH_SYSTEM_PROMPT = """Turn a short research brief into exactly five useful questions.

Rules:
- Each question must explore a different angle of the brief
- Questions must be specific, natural, and answerable

Return valid JSON only in this shape:
{"questions":["..."]}"""

QUESTION_ANSWER_SYSTEM_PROMPT = """Answer the supplied question properly, in about 5 to 6 lines.

Shape:
- Open with the direct answer in one sentence.
- Then give the detail that makes it useful: the numbers, the names, the caveat,
  what changed recently, or what people actually run into.
- Finish with the practical takeaway if there is one.

Do not pad to reach the length. If a question genuinely has a one-line answer,
say it and then say what sits behind it — why it is that way, or what it means
in practice.

When context is supplied, use only that context for factual claims. Do not invent
facts, statistics, quotes, or sources. Say plainly when something is uncertain or
when a figure is the latest you are aware of rather than current. Output only the
answer, no headings, no bullet characters."""


def draft_post(idea: str, context_snippets: Optional[List[str]] = None, style: str = "reddit") -> dict:
    """
    idea: 2-line user input (what they want to say)
    context_snippets: optional list of related Reddit quotes for tone matching
    style: "reddit" | "hn" | "pg"
    Returns: { draft, word_count, tone }
    """
    prompt_map = {"reddit": SYSTEM_PROMPT, "hn": HN_SYSTEM_PROMPT, "pg": PG_SYSTEM_PROMPT}
    system = prompt_map.get(style, SYSTEM_PROMPT)

    context = ""
    if context_snippets:
        context = "\n\nFor tone reference, here's how posts on this topic usually sound:\n"
        context += "\n".join(f"- {s}" for s in context_snippets[:5])

    user_prompt = f"Idea:\n{idea}{context}\n\nWrite the post."

    resp = get_client().chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.8,
        max_tokens=400,
    )
    draft = resp.choices[0].message.content.strip()
    word_count = len(draft.split())
    tone = detect_tone(draft)
    return {"draft": draft, "word_count": word_count, "tone": tone}


def draft_comment(post: str, intent: str) -> dict:
    """
    post: the Reddit post text the user is replying to
    intent: 1-2 lines describing what the user wants to say
    Returns: { draft, word_count, tone }
    """
    user_prompt = (
        f"The Reddit post I want to reply to:\n\"\"\"\n{post.strip()}\n\"\"\"\n\n"
        f"What I want to say in my comment:\n{intent.strip()}\n\n"
        "Write the comment."
    )
    resp = get_client().chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": COMMENT_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.8,
        max_tokens=300,
    )
    draft = resp.choices[0].message.content.strip()
    return {
        "draft": draft,
        "word_count": len(draft.split()),
        "tone": detect_tone(draft),
    }


def generate_question_batch(brief: str) -> dict:
    """Generate five distinct questions from a short brief."""
    resp = get_client().chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": QUESTION_BATCH_SYSTEM_PROMPT},
            {"role": "user", "content": f"Brief:\n{brief.strip()}"},
        ],
        response_format={"type": "json_object"},
        temperature=0.55,
        max_tokens=1200,
    )
    payload = json.loads(resp.choices[0].message.content)
    questions = payload.get("questions", [])
    if len(questions) != 5 or any(not isinstance(question, str) or not question.strip() for question in questions):
        raise ValueError("Question batch response was incomplete")
    return {"questions": questions}


SOURCED_ANSWER_SYSTEM_PROMPT = """Answer the question using ONLY the supplied Reddit results.

Return valid JSON only in this exact shape:
{"answer":"5 to 6 concise lines with [S1] source citations","claims":[{"text":"one factual claim","sources":[1,2]}]}

Rules:
- Every factual claim must use one or more source numbers from the supplied results.
- Every source number in a claim must appear in the answer as [S1], [S2], and so on.
- Every citation used in the answer must appear in the matching entry in the claims map.
- If evidence is incomplete or disagrees, say so plainly in the answer.
- Never add a fact, name, number, or date that is not in the supplied results.
- Do not include markdown headings or bullets in the answer.
"""

SOURCE_RELEVANCE_SYSTEM_PROMPT = """Score how directly each supplied Reddit result can answer the user's question.

Return valid JSON only in this exact shape:
{"coverage":0,"sources":[{"n":1,"relevance":0,"reason":"brief reason"}]}

Rules:
- Judge only the supplied title and snippet. Do not use outside knowledge.
- 80-100 means it directly addresses the question and contains useful evidence.
- 60-79 means it addresses a meaningful part of the question.
- Below 60 means it is incidental, off-topic, or too vague to support an answer.
- Coverage scores whether the combined sources support every material part of the question.
- A general discussion of the topic does not count as coverage of a specific mechanism, comparison, or measurement request.
- Return one entry for every supplied source number.
"""


def evaluate_question_sources(question: str, results: List[dict]) -> dict:
    """Score source relevance and return only evidence that is on topic."""
    if not results:
        return {"relevant": [], "score": 0, "coverage": 0, "communities": 0, "passed": False}
    listed = "\n\n".join(
        f"[S{i}] {result.get('title', '')}\n{result.get('snippet', '')}"
        for i, result in enumerate(results, 1)
    )
    resp = get_client().chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": SOURCE_RELEVANCE_SYSTEM_PROMPT},
            {"role": "user", "content": f"Question:\n{question.strip()}\n\nSources:\n{listed}"},
        ],
        response_format={"type": "json_object"},
        temperature=0,
        max_tokens=900,
    )
    payload = json.loads(resp.choices[0].message.content)
    scores = {}
    for item in payload.get("sources", []):
        if not isinstance(item, dict) or not isinstance(item.get("n"), int):
            continue
        relevance = max(0, min(100, int(item.get("relevance", 0))))
        scores[item["n"]] = {"relevance": relevance, "reason": str(item.get("reason", "")).strip()}
    scored = []
    for index, result in enumerate(results, 1):
        review = scores.get(index, {"relevance": 0, "reason": "No relevance score returned"})
        scored.append({**result, "relevance": review["relevance"], "relevance_reason": review["reason"]})
    relevant = sorted((item for item in scored if item["relevance"] >= 60), key=lambda item: item["relevance"], reverse=True)
    top_scores = [item["relevance"] for item in relevant[:3]]
    relevance_score = round(sum(top_scores) / 3) if top_scores else 0
    try:
        coverage = max(0, min(100, int(payload.get("coverage", 0))))
    except (TypeError, ValueError):
        coverage = 0
    communities = len({item.get("subreddit_name_prefixed", "") for item in relevant if item.get("subreddit_name_prefixed")})
    diversity_factor = min(1, communities / 2)
    evidence_score = round(relevance_score * diversity_factor * (coverage / 100))
    return {
        "relevant": relevant,
        "score": evidence_score,
        "coverage": coverage,
        "communities": communities,
        "passed": len(relevant) >= 3 and communities >= 2 and evidence_score >= 60,
    }

def validate_question_answer(answer: str, claims: object, source_count: int) -> dict:
    """Check that an answer has a usable, source-backed claim map."""
    cited = {int(n) for n in re.findall(r"\[S(\d+)\]", answer)}
    valid_citations = {n for n in cited if 1 <= n <= source_count}
    invalid_citations = sorted(cited - valid_citations)
    valid_claims = []
    mapped_citations = set()
    invalid_claims = 0
    if isinstance(claims, list):
        for claim in claims:
            if not isinstance(claim, dict) or not isinstance(claim.get("text"), str):
                invalid_claims += 1
                continue
            refs = claim.get("sources")
            if not isinstance(refs, list) or not refs or any(not isinstance(n, int) or n not in valid_citations for n in refs):
                invalid_claims += 1
                continue
            valid_claims.append({"text": claim["text"], "sources": refs})
            mapped_citations.update(refs)
    else:
        invalid_claims = 1
    unmapped_citations = sorted(valid_citations - mapped_citations)
    return {
        "passed": bool(answer.strip()) and source_count > 0 and bool(valid_claims) and not invalid_citations and not invalid_claims and not unmapped_citations,
        "claims": valid_claims,
        "claim_count": len(valid_claims),
        "cited_sources": len(valid_citations),
        "invalid_claims": invalid_claims,
        "invalid_citations": invalid_citations,
        "unmapped_citations": unmapped_citations,
    }


def generate_question_answer(brief: str, question: str, results: Optional[List[dict]] = None, feedback: str = "") -> dict:
    """Generate a source-backed answer and its structured claim map."""
    if results:
        listed = "\n\n".join(
            f"[S{i}] {r.get('title','')} — {r.get('site','')}"
            + (f" ({r['date']})" if r.get("date") else "")
            + f"\n{r.get('snippet','')}"
            for i, r in enumerate(results, 1)
        )
        context = f"Context:\n{brief.strip()}\n\n" if brief.strip() else ""
        user = f"{context}Search results:\n{listed}\n\nQuestion:\n{question.strip()}"
        if feedback:
            user += f"\n\nValidation feedback from the prior attempt:\n{feedback}\nReturn a corrected JSON response."
        system = SOURCED_ANSWER_SYSTEM_PROMPT
    else:
        context = f"Context:\n{brief.strip()}\n\n" if brief.strip() else ""
        user = f"{context}Question:\n{question.strip()}"
        system = QUESTION_ANSWER_SYSTEM_PROMPT

    request = {
        "model": "gpt-4o-mini",
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.2 if results else 0.4,
        "max_tokens": 600,
    }
    if results:
        request["response_format"] = {"type": "json_object"}
    resp = get_client().chat.completions.create(**request)
    content = resp.choices[0].message.content.strip()
    if not content:
        raise ValueError("Question answer was empty")
    if results:
        try:
            payload = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError("Question answer was not valid JSON") from exc
        answer = str(payload.get("answer", "")).strip()
        claims = payload.get("claims", [])
    else:
        answer, claims = content, []
    if not answer:
        raise ValueError("Question answer was empty")

    return {
        "answer": answer,
        "claims": claims,
        "sources": [
            {"n": i, "title": r.get("title", ""), "url": r.get("url", ""), "site": r.get("site", ""), "date": r.get("date", ""), "permalink": r.get("permalink", ""), "subreddit_name_prefixed": r.get("subreddit_name_prefixed", ""), "selftext": r.get("selftext", "")}
            for i, r in enumerate(results or [], 1)
        ],
        "sourced": bool(results),
    }

PLAN_QUERIES_SYSTEM_PROMPT = """You turn a user's question into Google searches that find relevant Reddit threads.

Return JSON: {"queries": [3 to 5 short search strings], "intent": one of "comparison", "pain", "recommendation", "pricing", "general"}

Rules:
- Each query is 2-8 words, keyword style, no question marks
- Do not add the word "reddit" (it is added later)
- Cover different angles of the question, not rewordings of the same words
- intent is "comparison" only when the user compares named products (X vs Y)"""


ANSWER_SYSTEM_PROMPT = """You answer questions using ONLY the Reddit threads provided.

Rules:
- Every factual claim must cite its source thread as [n], using the numbers given
- If the threads do not contain enough to answer, say so plainly and say what is missing. Never fill gaps from your own knowledge.
- Plain, direct language. Short paragraphs or a short list. 60-200 words.
- Report what Reddit users say, with their tone (e.g. "several users complain…", "one user switched because…")
- No preamble, no closing summary, no markdown headings"""


def plan_queries(question: str) -> dict:
    """Turn a free-form question into Reddit search queries."""
    resp = get_client().chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": PLAN_QUERIES_SYSTEM_PROMPT},
            {"role": "user", "content": question.strip()},
        ],
        response_format={"type": "json_object"},
        temperature=0.3,
        max_tokens=300,
    )
    payload = json.loads(resp.choices[0].message.content)
    queries = [q.strip() for q in payload.get("queries", []) if isinstance(q, str) and q.strip()][:5]
    if not queries:
        queries = [question.strip()]
    return {"queries": queries, "intent": payload.get("intent", "general")}


def answer_from_threads(question: str, threads: List[dict], history: Optional[List[dict]] = None) -> str:
    """Answer a question strictly from the given threads, citing them as [n]."""
    sources = "\n\n".join(
        f"[{i}] {t.get('subreddit_name_prefixed', '')} — {t.get('title', '')}\n{t.get('selftext', '')}"
        for i, t in enumerate(threads, 1)
    )
    messages = [{"role": "system", "content": ANSWER_SYSTEM_PROMPT}]
    for turn in (history or [])[-6:]:
        if turn.get("role") in ("user", "assistant") and turn.get("content"):
            messages.append({"role": turn["role"], "content": turn["content"]})
    messages.append({"role": "user", "content": f"Reddit threads:\n\n{sources}\n\nQuestion: {question.strip()}"})
    resp = get_client().chat.completions.create(
        model="gpt-4o-mini",
        messages=messages,
        temperature=0.3,
        max_tokens=500,
    )
    answer = resp.choices[0].message.content.strip()
    if not answer:
        raise ValueError("Answer was empty")
    return answer


def detect_tone(text: str) -> str:
    """Cheap heuristic tone detector — no LLM call."""
    t = text.lower()
    if any(w in t for w in ["amazing", "love", "awesome", "fantastic", "game changer"]):
        return "enthusiastic"
    if any(w in t for w in ["frustrated", "annoyed", "hate", "broken", "terrible"]):
        return "frustrated"
    if any(w in t for w in ["thinking about", "considering", "wondering", "anyone else"]):
        return "thoughtful"
    if "?" in text and text.count("?") >= 2:
        return "questioning"
    return "casual"
