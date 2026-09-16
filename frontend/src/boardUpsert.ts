import type { BoardCard } from './Board'

// One Reddit thread can appear as many URLs (old./www., slug or not, ?utm, trailing slash).
// The id after /comments/ is the same in all of them, so that is what we match on.
export function threadKey(url: string): string {
  const raw = (url || '').trim()
  const id = raw.match(/\/comments\/([a-z0-9]+)/i)
  if (id) return `reddit:${id[1].toLowerCase()}`
  try {
    const u = new URL(raw)
    const host = u.hostname.replace(/^(www|old|new|m)\./, '')
    return `url:${host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase()
  } catch {
    return `url:${raw.replace(/[?#].*$/, '').replace(/\/+$/, '')}`.toLowerCase()
  }
}

export type ReplyForBoard = { url: string; draft: string; preview?: string; subreddit?: string }

// Attach a reply to the thread's existing card (the most recently touched one), or create a card.
export function upsertReplyCard(board: BoardCard[], reply: ReplyForBoard, now = new Date().toISOString()): { board: BoardCard[]; action: 'updated' | 'added'; id: string } {
  const key = threadKey(reply.url)
  const matches = board
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => (card.thread_id || threadKey(card.source_url)) === key)
  if (matches.length > 0) {
    const target = matches.reduce((best, m) => ((m.card.updated_at || '') >= (best.card.updated_at || '') ? m : best))
    const next = board.map((card, index) => (index === target.index ? { ...card, draft: reply.draft, column: 'ready' as const, thread_id: key, updated_at: now } : card))
    return { board: next, action: 'updated', id: target.card.id }
  }
  const preview = (reply.preview || '').trim()
  const subreddit = reply.subreddit || (reply.url.match(/\/r\/([^/]+)/i)?.[1] ? `r/${reply.url.match(/\/r\/([^/]+)/i)![1]}` : 'Reddit')
  const id = `reply::${key}`
  const card: BoardCard = {
    id,
    title: preview ? preview.split('\n')[0].slice(0, 100) : undefined,
    text: preview || reply.url,
    source_url: reply.url,
    subreddit,
    reddit_score: 0,
    origin: 'reply',
    column: 'ready',
    draft: reply.draft,
    thread_id: key,
    updated_at: now,
  }
  return { board: [...board, card], action: 'added', id }
}
