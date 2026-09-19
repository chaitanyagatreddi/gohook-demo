# GoHook

> Your knowledge graph for Reddit.

Find the Reddit threads your buyers are already in, write something worth posting, and keep track of what you sent.

Live at [gohooklive.vercel.app](https://gohooklive.vercel.app).

## What it does

| Section | What it does |
|---|---|
| **Ask** | Scan Reddit for a product or question. Results split into pricing, complaints, comparisons, praise and quotes. |
| **Board** | Save threads and drafts. Columns: New, Reviewing, Ready to post, Actioned. |
| **Ideate** | Two ways to start a post: from your own idea, or from a URL. Paste a link and it finds the subreddits already discussing it, then gives you angles that start a discussion instead of reading like an ad. |
| **Reply to Threads** | Paste a thread, say what you want to add, get a reply that fits the conversation. One click saves it to the Board. |
| **Research** | Ask a question, get an answer built only from Reddit threads, with every claim tied to a source. When the evidence is thin it says so and holds the answer back rather than guessing. |
| **Graph** | Your threads, subreddits and topics, and how they connect. Tracks subscribed subreddits and a thread's score over time. |
| **Your voice** | Paste a few lines you wrote, or use your own Reddit posts, and drafts come back sounding like you. Only the style is stored, never the text. |

## How the answer checking works

Research runs each question through the same checks and shows them as it goes:

1. Understand the question and build a search target.
2. Search Reddit, drop dead links and duplicates.
3. Score how well each thread answers the question.
4. Search again, more broadly, if the evidence is thin.
5. Write the answer, with each claim mapped to a source.
6. Fix or drop citations that don't hold up.

There are two bars, depending on the question. A "best X" or "X vs Y" question needs 3 relevant threads across 2 communities and a score of 60. A plain "how does X work" question can pass on one strong, on-topic thread. If neither is met the answer is held back, and the screen says which check failed and by how much.

## Stack

- **Frontend**: React, Vite, Tailwind v4, Motion
- **Backend**: FastAPI
- **Database and auth**: Supabase (email link or Google sign-in)
- **Search**: [Serper.dev](https://serper.dev) over Google, scoped to Reddit
- **Page reading**: [Parallel](https://parallel.ai) extract, for Reddit threads and article links
- **Reddit account**: [Composio](https://composio.dev) OAuth, for profile, own posts and posting
- **Model**: OpenAI gpt-4o-mini
- **Scheduling**: [Zernio](https://zernio.com), each user connects their own key in Settings

**Why not Reddit's own API?** Reddit's [Responsible Builder Policy](https://www.reddit.com/r/redditdev/comments/1oug31u/introducing_the_responsible_builder_policy_new/) (Nov 2025) put new API access behind manual approval. GoHook reads public threads through search, and uses Composio's approved app for anything tied to a user's account.

## Running it locally

**You need:** Python 3.10+, Node 18+, a [Serper.dev](https://serper.dev) key, an OpenAI key, and a [Supabase](https://supabase.com) project.

```bash
git clone https://github.com/chaitanyagatreddi/gohook-demo.git
cd gohook-demo
```

Backend:

```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env              # SERPER_API_KEY, OPENAI_API_KEY, SUPABASE_URL,
                                  # SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
uvicorn main:app --reload --port 8000
```

`COMPOSIO_API_KEY` and `PARALLEL_API_KEY` are optional. Without them, connecting a Reddit account and reading full thread text are off; everything else works.

Frontend, in a second terminal:

```bash
cd frontend
npm install
# .env.local needs VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_URL
npm run dev
```

Open `http://localhost:5173`. Signed-out visitors get 3 searches before sign-in is required.

Database tables live in `supabase/migrations`, applied in order.

## Deploying

Two Vercel projects, both from this repo:

- **Frontend** (`gohooklive`, root `frontend`): `main` is production, `staging` is the staging site.
- **Backend** (`backend`, root `backend`): not connected to git. Deploy by hand with `vercel --prod` from `backend/`.

## Recent changes

- Reddit Presence Score: fixed weights to match spec (buying-intent 20, not 30) and made Recency its own scored part instead of a hidden discount on Earned Mentions.
- Every generated draft (post, comment, angle) now runs through a typo-only fix and has its first letter capitalized before being returned.
- `/reddit/sync` now also records subscribed subreddits (as `subscribed` edges) and a score snapshot for each of the user's own posts/comments, both feeding the Graph. Viewing this in the UI, and detecting *newly* joined subreddits specifically, is not built yet.
- Onboarding role dropdown now includes CEO and CTO.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md). Note: this predates the graph, audit, and Composio integration — it describes an earlier version of the app.

## License

MIT
