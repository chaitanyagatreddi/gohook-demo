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

QUESTION_ANSWER_SYSTEM_PROMPT = """Write one concise, direct answer to the supplied question.

When context is supplied, use only that context for factual claims. Do not invent facts, statistics, quotes, or sources. If reliable facts are unavailable, give practical guidance without pretending it is verified. Output only the answer."""


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


def generate_question_answer(brief: str, question: str) -> dict:
    """Generate one answer for one selected question."""
    context = f"Context:\n{brief.strip()}\n\n" if brief.strip() else ""
    resp = get_client().chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": QUESTION_ANSWER_SYSTEM_PROMPT},
            {"role": "user", "content": f"{context}Question:\n{question.strip()}"},
        ],
        temperature=0.4,
        max_tokens=350,
    )
    answer = resp.choices[0].message.content.strip()
    if not answer:
        raise ValueError("Question answer was empty")
    return {"answer": answer}


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
