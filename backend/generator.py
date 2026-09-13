"""
Reddit post drafter — takes a 2-line idea, generates a draft post that fits Reddit.
Uses OpenAI gpt-4o-mini (cheap, fast).
"""
import json
import os
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


SOURCED_ANSWER_SYSTEM_PROMPT = """Answer the question using ONLY the search results supplied, in about 5 to 6 lines.

Shape:
- Open with the direct answer in one sentence.
- Then the detail that makes it useful: the numbers, the names, the caveat, what changed.
- Finish with the practical takeaway if there is one.

Rules:
- Every fact must come from the results. Never add a number, name or date that is not there.
- Mark each fact with the source it came from, like [2], matching the numbers given.
- If the results disagree, say so and give both.
- If the results do not answer the question, say plainly that you could not find it.
  Do not fall back on what you remember.
- Where a figure has a date attached, say the date — "as of 2024" — rather than
  implying it is today's number.
- Output only the answer. No headings, no bullet characters."""


def generate_question_answer(brief: str, question: str, results: Optional[List[dict]] = None) -> dict:
    """
    Answer one question.

    With `results` (from a web search) the answer is built only from those and
    carries [n] marks. Without them it falls back to the model's own knowledge,
    which is not sourced.
    """
    if results:
        listed = "\n\n".join(
            f"[{i}] {r.get('title','')} — {r.get('site','')}"
            + (f" ({r['date']})" if r.get("date") else "")
            + f"\n{r.get('snippet','')}"
            for i, r in enumerate(results, 1)
        )
        context = f"Context:\n{brief.strip()}\n\n" if brief.strip() else ""
        user = f"{context}Search results:\n{listed}\n\nQuestion:\n{question.strip()}"
        system = SOURCED_ANSWER_SYSTEM_PROMPT
    else:
        context = f"Context:\n{brief.strip()}\n\n" if brief.strip() else ""
        user = f"{context}Question:\n{question.strip()}"
        system = QUESTION_ANSWER_SYSTEM_PROMPT

    resp = get_client().chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.2 if results else 0.4,
        max_tokens=600,
    )
    answer = resp.choices[0].message.content.strip()
    if not answer:
        raise ValueError("Question answer was empty")

    return {
        "answer": answer,
        "sources": [
            {
                "n": i,
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "site": r.get("site", ""),
                "date": r.get("date", ""),
                "permalink": r.get("permalink", ""),
                "subreddit_name_prefixed": r.get("subreddit_name_prefixed", ""),
                "selftext": r.get("selftext", ""),
            }
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
