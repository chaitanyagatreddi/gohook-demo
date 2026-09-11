import { useState, useEffect, useRef } from 'react'
import Board, { type BoardCard } from './Board'
import { supabase } from './supabaseClient'
import type { Session } from '@supabase/supabase-js'
import OnboardingDeck from './OnboardingDeck'
import LoadingScreen from './LoadingScreen'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

type ResultItem = {
  text: string
  source_url: string
  reddit_score: number
  subreddit: string
  category?: string
}

type Intel = {
  query: string
  total_posts_scanned: number
  subreddits_searched: string[]
  expanded: boolean
  pricing: ResultItem[]
  complaints: ResultItem[]
  comparisons: ResultItem[]
  praise: ResultItem[]
  quotes: ResultItem[]
}

type Tab = 'pricing' | 'complaints' | 'comparisons' | 'praise' | 'quotes'

const TAB_LABELS: Record<Tab, string> = {
  pricing: '💰 Pricing',
  complaints: '😤 Complaints',
  comparisons: '⚖️ Comparisons',
  praise: '💚 Praise',
  quotes: '💬 Quotes',
}

function ResultCard({ item, onReply, onAdd, added }: { item: ResultItem; onReply?: (text: string) => void; onAdd?: (item: ResultItem) => void; added?: boolean }) {
  return (
    <div className="border border-[#242a33] bg-[#14171c] rounded-xl p-4 hover:border-[#ff4500]/50 transition-colors">
      <p className="text-[#e8eaed] text-sm leading-relaxed">{item.text}</p>
      <div className="mt-3 flex items-center gap-3 text-xs text-[#9aa4b2]">
        <span>{item.subreddit}</span>
        {item.reddit_score > 0 && <span>▲ {item.reddit_score}</span>}
        {item.category && (
          <span className="bg-[#ff4500]/10 text-[#ff6a33] px-2 py-0.5 rounded">
            {item.category}
          </span>
        )}
        <a
          href={item.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-[#ff6a33] hover:underline"
        >
          view thread →
        </a>
        {onAdd && (
          <button
            onClick={() => onAdd(item)}
            disabled={added}
            className="text-[#9aa4b2] hover:text-[#ff6a33] transition-colors disabled:text-[#50c878] disabled:cursor-default"
            title={added ? 'On the board' : 'Add to board'}
          >
            {added ? '✓ Board' : '+ Board'}
          </button>
        )}
        {onReply && (
          <button
            onClick={() => onReply(item.text)}
            className="text-[#9aa4b2] hover:text-[#ff6a33] transition-colors"
            title="Reply to this"
          >
            ↩ Reply
          </button>
        )}
      </div>
    </div>
  )
}

type Draft = { draft: string; word_count: number; tone: string }
type QuestionAnswer = { question: string; answer?: string }

const TAB_META: Record<Tab, { icon: string; label: string }> = {
  pricing: { icon: '💰', label: 'Pricing' },
  complaints: { icon: '😤', label: 'Complaints' },
  comparisons: { icon: '⚖️', label: 'Comparisons' },
  praise: { icon: '💚', label: 'Praise' },
  quotes: { icon: '💬', label: 'Quotes' },
}

export default function App() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [intel, setIntel] = useState<Intel | null>(null)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<Tab>('quotes')
  const [copied, setCopied] = useState(false)

  // View + Kanban board
  const [view, setView] = useState<'results' | 'questions' | 'board' | 'settings'>('results')
  const [board, setBoard] = useState<BoardCard[]>(() => {
    try {
      const raw = localStorage.getItem('redditscan_board')
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  })
  useEffect(() => {
    localStorage.setItem('redditscan_board', JSON.stringify(board))
  }, [board])

  function addToBoard(item: ResultItem, origin: Tab) {
    const id = `${item.source_url}::${item.text.slice(0, 40)}`
    setBoard(prev => (prev.some(c => c.id === id) ? prev : [
      ...prev,
      {
        id,
        text: item.text,
        source_url: item.source_url,
        subreddit: item.subreddit,
        reddit_score: item.reddit_score,
        category: item.category,
        origin,
        column: 'new',
      },
    ]))
  }
  const boardIds = new Set(board.map(c => c.id))

  // Compose section (Notepad + Reply) collapsed by default
  const [composeOpen, setComposeOpen] = useState(false)

  // Notepad state
  const [idea, setIdea] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftError, setDraftError] = useState('')
  const [draftCopied, setDraftCopied] = useState(false)
  const [draftPlatform, setDraftPlatform] = useState<'reddit' | 'hn' | 'pg'>('reddit')

  // Batch questions state
  const [questionBrief, setQuestionBrief] = useState('')
  const [questionBatch, setQuestionBatch] = useState<QuestionAnswer[]>([])
  const [questionBatchError, setQuestionBatchError] = useState('')
  const [answeringIndex, setAnsweringIndex] = useState<number | null>(null)
  const [answerErrors, setAnswerErrors] = useState<Record<number, string>>({})

  function createQuestionBatch() {
    const questions = questionBrief.split('\n').map(question => question.trim()).filter(Boolean)
    setQuestionBatchError('')
    if (questions.length < 2 || questions.length > 3) {
      setQuestionBatchError('Enter 2 or 3 questions, one per line.')
      return
    }
    setAnswerErrors({})
    setQuestionBatch(questions.map(question => ({ question })))
  }

  async function generateAnswer(index: number) {
    const item = questionBatch[index]
    if (!item) return
    setAnsweringIndex(index)
    setAnswerErrors(prev => ({ ...prev, [index]: '' }))
    try {
      const res = await fetch(`${API}/question-answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: item.question }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Answer generation failed')
      }
      const data = await res.json()
      setQuestionBatch(prev => prev.map((entry, entryIndex) => entryIndex === index ? { ...entry, answer: data.answer } : entry))
    } catch (e: unknown) {
      setAnswerErrors(prev => ({ ...prev, [index]: e instanceof Error ? e.message : 'Something went wrong' }))
    } finally {
      setAnsweringIndex(null)
    }
  }

  // Schedule state
  const [scheduling, setScheduling] = useState(false)
  const [scheduleResult, setScheduleResult] = useState<{ post_id: string; status: string } | null>(null)
  const [scheduleError, setScheduleError] = useState('')
  const [subreddit, setSubreddit] = useState('')
  const [subredditSearch, setSubredditSearch] = useState('')
  const [subreddits, setSubreddits] = useState<string[]>([])
  const [showSubredditDropdown, setShowSubredditDropdown] = useState(false)
  const [scheduleTime, setScheduleTime] = useState('')

  // Auth + Zernio connection state
  const [session, setSession] = useState<Session | null>(null)
  const [authEmail, setAuthEmail] = useState('')
  const [authSent, setAuthSent] = useState(false)
  const [authError, setAuthError] = useState('')
  const [zernioConnected, setZernioConnected] = useState(false)
  const [zernioKeyInput, setZernioKeyInput] = useState('')
  const [zernioConnecting, setZernioConnecting] = useState(false)
  const [zernioError, setZernioError] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (session) setShowAuthGate(false)
  }, [session])

  async function authHeaders(): Promise<Record<string, string>> {
    const { data } = await supabase.auth.getSession()
    return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}
  }

  async function sendMagicLink() {
    if (!authEmail.trim()) return
    setAuthError('')
    const { error } = await supabase.auth.signInWithOtp({ email: authEmail })
    if (error) setAuthError(error.message)
    else setAuthSent(true)
  }

  async function connectZernio() {
    if (!zernioKeyInput.trim()) return
    setZernioConnecting(true)
    setZernioError('')
    try {
      const headers = await authHeaders()
      const res = await fetch(`${API}/zernio/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ zernio_api_key: zernioKeyInput }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Connection failed')
      }
      setZernioConnected(true)
      setZernioKeyInput('')
    } catch (e: unknown) {
      setZernioError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setZernioConnecting(false)
    }
  }

  // Comment generator state
  const commentRef = useRef<HTMLDivElement>(null)
  const [postText, setPostText] = useState('')
  const [intent, setIntent] = useState('')
  const [commenting, setCommenting] = useState(false)
  const [comment, setComment] = useState<Draft | null>(null)
  const [commentError, setCommentError] = useState('')
  const [commentCopied, setCommentCopied] = useState(false)
  const [commentPlatform, setCommentPlatform] = useState<'reddit' | 'hn'>('reddit')

  // Auto-search from URL param: ?q=Notion
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const q = params.get('q')
    if (q) {
      setQuery(q)
      doSearch(q)
    }
  }, [])

  // Load subreddits from Zernio (once a connection exists)
  useEffect(() => {
    if (!session) return
    authHeaders().then(headers => {
      fetch(`${API}/subreddits`, { headers })
        .then(r => {
          if (r.ok) setZernioConnected(true)
          return r.json()
        })
        .then(data => { if (Array.isArray(data)) setSubreddits(data) })
        .catch(() => {})
    })
  }, [session])

  const COMPARISON_PATTERN = /\bvs\.?\b|\bversus\b/i
  const FREE_SEARCH_LIMIT = 3
  const [searchCount, setSearchCount] = useState(() => {
    const raw = localStorage.getItem('redditscan_search_count')
    return raw ? parseInt(raw, 10) || 0 : 0
  })
  const [showAuthGate, setShowAuthGate] = useState(false)
  const [gateLoading, setGateLoading] = useState(true)

  async function doSearch(q: string, expand = false) {
    if (!q.trim()) return
    if (!session && searchCount >= FREE_SEARCH_LIMIT) {
      setShowAuthGate(true)
      return
    }
    if (!COMPARISON_PATTERN.test(q)) {
      setError("Enter a comparison like 'Notion vs Asana' — GoHook only scans head-to-head comparisons.")
      return
    }
    setLoading(true)
    setError('')
    if (!expand) setIntel(null)
    try {
      const res = await fetch(`${API}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, expand }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Search failed')
      }
      const data = await res.json()
      setIntel(data)
      window.history.replaceState({}, '', `?q=${encodeURIComponent(q)}`)
      if (!session) {
        setSearchCount(prev => {
          const next = prev + 1
          localStorage.setItem('redditscan_search_count', String(next))
          return next
        })
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  // Expand-search preview shows when results are thin and we haven't expanded yet
  const EXPAND_QUERIES = [
    'worth it honest',
    'vs alternative',
    'experience after months',
    'stopped using cancelled',
    'is good or bad',
  ]
  const showExpandPreview =
    intel && !intel.expanded && intel.total_posts_scanned < 15

  function handleShare() {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function generateDraft() {
    if (!idea.trim()) return
    setDrafting(true)
    setDraftError('')
    setDraft(null)
    try {
      // Use top quotes as tone context if we have intel
      const context_snippets = intel
        ? intel.quotes.slice(0, 5).map(q => q.text)
        : null
      const res = await fetch(`${API}/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idea, context_snippets, style: draftPlatform }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Draft failed')
      }
      setDraft(await res.json())
    } catch (e: unknown) {
      setDraftError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setDrafting(false)
    }
  }

  function copyDraft() {
    if (!draft) return
    navigator.clipboard.writeText(draft.draft)
    setDraftCopied(true)
    setTimeout(() => setDraftCopied(false), 2000)
  }

  async function schedulePost() {
    if (!draft) return
    setScheduling(true)
    setScheduleError('')
    setScheduleResult(null)
    try {
      const headers = await authHeaders()
      const res = await fetch(`${API}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          content: draft.draft,
          subreddit,
          scheduled_for: scheduleTime ? new Date(scheduleTime).toISOString() : undefined,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Schedule failed')
      }
      setScheduleResult(await res.json())
    } catch (e: unknown) {
      setScheduleError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setScheduling(false)
    }
  }

  async function generateComment() {
    if (!postText.trim() || !intent.trim()) return
    setCommenting(true)
    setCommentError('')
    setComment(null)
    try {
      const res = await fetch(`${API}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post: postText, intent, platform: commentPlatform }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Comment failed')
      }
      setComment(await res.json())
    } catch (e: unknown) {
      setCommentError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setCommenting(false)
    }
  }

  function handleReply(text: string) {
    setPostText(text)
    setComment(null)
    setCommentError('')
    setIntent('')
    setComposeOpen(true)
    setTimeout(() => commentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
  }

  function copyComment() {
    if (!comment) return
    navigator.clipboard.writeText(comment.draft)
    setCommentCopied(true)
    setTimeout(() => setCommentCopied(false), 2000)
  }

  const activeResults = intel ? intel[activeTab] : []

  return (
    <div className="min-h-screen bg-[#0b0d10] text-[#e8eaed] flex items-start">
      {/* Left rail. Layout borrowed from GTM Predictor; GoHook colours. */}
      {!(showAuthGate && !session) && (
        <aside className="sticky top-0 h-screen flex-none w-16 md:w-60 flex flex-col bg-[#14171c] border-r border-[#242a33] py-5">
          <div className="px-0 md:px-5 mb-6 flex flex-col items-center md:items-start">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-[#ff4500]" />
              <h1 className="hidden md:block text-lg font-bold tracking-tight">GoHook</h1>
            </div>
            <p className="hidden md:block text-xs text-[#9aa4b2] mt-2 leading-snug">
              Reddit, focus mode: pricing, complaints, comparisons, no noise.
            </p>
          </div>
          <nav className="flex-1 overflow-y-auto px-2 md:px-3 flex flex-col gap-1">
            {([
              { key: 'results', label: 'Results', icon: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></> },
              { key: 'board', label: 'Board', icon: <><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="11" rx="1" /><rect x="17" y="4" width="4" height="7" rx="1" /></> },
              { key: 'questions', label: 'Questions', icon: <><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></> },
              { key: 'settings', label: 'Settings', icon: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></> },
            ] as const).map(item => (
              <button
                key={item.key}
                onClick={() => setView(item.key)}
                title={item.label}
                className={`flex items-center justify-center md:justify-start gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${view === item.key ? 'bg-[#ff4500] text-white' : 'text-[#9aa4b2] hover:text-[#e8eaed] hover:bg-[#242a33]'}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="w-[18px] h-[18px] flex-none">{item.icon}</svg>
                <span className="hidden md:inline">
                  {item.label}
                  {item.key === 'board' && board.length > 0 && <span className="opacity-80"> ({board.length})</span>}
                </span>
              </button>
            ))}
          </nav>
        </aside>
      )}

      <main className="flex-1 min-w-0">
      {showAuthGate && !session ? (
        <div className="max-w-3xl mx-auto px-4 py-10">
          {gateLoading ? (
            <LoadingScreen onDone={() => setGateLoading(false)} />
          ) : (
          <OnboardingDeck
            signInOnly
            authEmail={authEmail}
            setAuthEmail={setAuthEmail}
            authSent={authSent}
            authError={authError}
            sendMagicLink={sendMagicLink}
            session={!!session}
            zernioKeyInput={zernioKeyInput}
            setZernioKeyInput={setZernioKeyInput}
            zernioConnecting={zernioConnecting}
            zernioError={zernioError}
            zernioConnected={zernioConnected}
            connectZernio={connectZernio}
            onDone={() => setShowAuthGate(false)}
          />
          )}
        </div>
      ) : (
      <div className="max-w-3xl mx-auto px-4 py-10">
        {/* Hero + search bar */}
        {!intel && !loading && view === 'results' && (
          <div className="text-center mb-6">
            <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight leading-tight">
              Reddit signal.<br />
              <span className="bg-gradient-to-r from-[#ff4500] to-[#ff6a33] bg-clip-text text-transparent">
                Zero noise.
              </span>
            </h2>
            <p className="text-[#9aa4b2] mt-3 max-w-md mx-auto">
              Drop a product name. Get the pricing, complaints, and comparisons, ranked, no scrolling.
            </p>
          </div>
        )}

        {view === 'results' && <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && doSearch(query)}
            placeholder="Enter a product name (e.g. Notion, Linear, Salesforce)"
            className="flex-1 min-w-0 bg-[#14171c] border border-[#242a33] rounded-xl px-4 py-3 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
          />
          <button
            onClick={() => doSearch(query)}
            disabled={loading}
            className="bg-[#ff4500] hover:bg-[#ff6a33] text-white px-6 py-3 rounded-xl text-sm font-semibold disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {loading ? 'Scanning…' : 'Scan Reddit'}
          </button>
        </div>}

        {view === 'results' && error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        {/* Loading skeleton */}
        {view === 'results' && loading && (
          <div className="mt-8 space-y-3 animate-pulse">
            <div className="h-14 rounded-xl bg-[#14171c] border border-[#242a33]" />
            {[0, 1, 2].map(i => (
              <div key={i} className="h-20 rounded-xl bg-[#14171c] border border-[#242a33]" />
            ))}
          </div>
        )}

        {view === 'board' && <Board board={board} setBoard={setBoard} />}

        {view === 'questions' && (
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Batch questions</h2>
            <p className="text-sm text-[#9aa4b2] mt-2">Enter 2 or 3 questions, one per line. Generate each answer individually.</p>
            <textarea
              value={questionBrief}
              onChange={e => setQuestionBrief(e.target.value)}
              rows={3}
              placeholder={'What problem are users trying to solve?\nWhat alternatives do they compare?\nWhat makes them switch?'}
              className="mt-5 w-full bg-[#14171c] border border-[#242a33] rounded-xl px-4 py-3 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60 resize-none"
            />
            <div className="mt-3 flex justify-end">
              <button
                onClick={createQuestionBatch}
                disabled={!questionBrief.trim()}
                className="bg-[#ff4500] hover:bg-[#ff6a33] text-white px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-colors"
              >
                Create question batch
              </button>
            </div>
            {questionBatchError && <p className="mt-3 text-sm text-red-400">{questionBatchError}</p>}
            {questionBatch.length > 0 && (
              <div className="mt-7 space-y-3">
                {questionBatch.map((item, index) => (
                  <article key={`${index}-${item.question}`} className="border border-[#242a33] bg-[#14171c] rounded-xl p-5">
                    <div className="flex gap-3">
                      <span className="text-xs text-[#ff6a33] font-mono pt-1">0{index + 1}</span>
                      <div>
                        <h3 className="text-base font-semibold text-[#e8eaed]">{item.question}</h3>
                        {item.answer ? (
                          <p className="mt-3 text-sm leading-relaxed text-[#9aa4b2] whitespace-pre-wrap">{item.answer}</p>
                        ) : (
                          <button
                            onClick={() => generateAnswer(index)}
                            disabled={answeringIndex !== null}
                            className="mt-4 border border-[#ff4500] text-[#ff6a33] hover:bg-[#ff4500]/10 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-colors"
                          >
                            {answeringIndex === index ? 'Generating answer…' : 'Generate answer'}
                          </button>
                        )}
                        {answerErrors[index] && <p className="mt-3 text-sm text-red-400">{answerErrors[index]}</p>}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}

        {view === 'settings' && (
          <div className="max-w-md">
            <h2 className="text-lg font-semibold text-[#e8eaed] mb-4">API Keys</h2>
            <div className="border border-[#242a33] bg-[#14171c] rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-[#e8eaed]">Zernio</p>
                <span className={`text-xs px-2 py-0.5 rounded ${zernioConnected ? 'bg-green-500/10 text-green-400' : 'bg-[#242a33] text-[#9aa4b2]'}`}>
                  {zernioConnected ? 'Connected' : 'Not connected'}
                </span>
              </div>
              {!session ? (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-[#9aa4b2] mb-1">Sign in first to connect Zernio.</p>
                  <input
                    type="email"
                    value={authEmail}
                    onChange={e => setAuthEmail(e.target.value)}
                    placeholder="you@email.com"
                    className="bg-[#0b0d10] border border-[#242a33] rounded-lg px-3 py-2 text-xs text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
                  />
                  <button
                    onClick={sendMagicLink}
                    disabled={authSent}
                    className="bg-[#ff4500] hover:bg-[#ff6a33] text-white px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors"
                  >
                    {authSent ? 'Check your email ✓' : 'Sign in with email'}
                  </button>
                  {authError && <p className="text-xs text-red-400">{authError}</p>}
                </div>
              ) : !zernioConnected ? (
                <div className="flex flex-col gap-2">
                  <input
                    type="text"
                    value={zernioKeyInput}
                    onChange={e => setZernioKeyInput(e.target.value)}
                    placeholder="Paste your Zernio API key"
                    className="bg-[#0b0d10] border border-[#242a33] rounded-lg px-3 py-2 text-xs text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
                  />
                  <button
                    onClick={connectZernio}
                    disabled={zernioConnecting}
                    className="bg-[#ff4500] hover:bg-[#ff6a33] text-white px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors"
                  >
                    {zernioConnecting ? 'Connecting…' : 'Connect'}
                  </button>
                  <a
                    href="https://zernio.com/signup"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[#9aa4b2] hover:text-[#ff6a33] underline"
                  >
                    Don't have a Zernio key? Get one →
                  </a>
                  {zernioError && <p className="text-xs text-red-400">{zernioError}</p>}
                </div>
              ) : (
                <p className="text-xs text-[#9aa4b2]">Zernio is connected — you can schedule posts to Reddit.</p>
              )}
            </div>
          </div>
        )}

        {view === 'results' && intel && !loading && (
          <div className="mt-8">
            {/* Meta + share */}
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-[#9aa4b2]">
                Scanned <strong className="text-[#e8eaed]">{intel.total_posts_scanned}</strong> posts for{' '}
                <strong className="text-[#e8eaed]">"{intel.query}"</strong>
              </p>
              <button
                onClick={handleShare}
                className="text-sm text-[#ff6a33] hover:underline"
              >
                {copied ? '✓ Copied!' : 'Share results ↗'}
              </button>
            </div>

            {/* Summary stat tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-5">
              {(Object.keys(TAB_META) as Tab[]).map(tab => {
                const active = activeTab === tab
                return (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                      active
                        ? 'border-[#ff4500] bg-[#ff4500]/10'
                        : 'border-[#242a33] bg-[#14171c] hover:border-[#3a4250]'
                    }`}
                  >
                    <div className="text-xl font-bold">{intel[tab].length}</div>
                    <div className="text-xs text-[#9aa4b2] mt-0.5">
                      {TAB_META[tab].icon} {TAB_META[tab].label}
                    </div>
                  </button>
                )
              })}
            </div>

            {/* Expand search preview */}
            {showExpandPreview && (
              <div className="mb-5 border border-[#ff4500]/30 bg-[#ff4500]/5 rounded-xl p-4">
                <p className="text-sm text-[#e8eaed] font-medium">
                  Only {intel.total_posts_scanned} posts found. Want a wider net?
                </p>
                <p className="text-xs text-white mt-1">
                  Expanding runs 5 more searches:
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {EXPAND_QUERIES.map(q => (
                    <span
                      key={q}
                      className="text-xs bg-[#14171c] border border-[#ff4500]/30 text-white px-2 py-0.5 rounded"
                    >
                      "{intel.query} {q}"
                    </span>
                  ))}
                </div>
                <button
                  onClick={() => doSearch(intel.query, true)}
                  disabled={loading}
                  className="mt-3 bg-[#ff4500] hover:bg-[#ff6a33] text-white text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-50 transition-colors"
                >
                  {loading ? 'Expanding…' : 'Expand search →'}
                </button>
              </div>
            )}

            {/* Active tab heading */}
            <h3 className="text-sm font-semibold text-[#9aa4b2] mb-3">
              {TAB_LABELS[activeTab]} <span className="text-[#6b7280]">· {intel[activeTab].length}</span>
            </h3>

            {/* Results */}
            {activeResults.length === 0 ? (
              <p className="text-sm text-[#6b7280] py-10 text-center">
                No {activeTab} found for this product.
              </p>
            ) : (
              <div className="space-y-3">
                {activeResults.map((item, i) => (
                  <ResultCard
                    key={i}
                    item={item}
                    onReply={handleReply}
                    onAdd={it => addToBoard(it, activeTab)}
                    added={boardIds.has(`${item.source_url}::${item.text.slice(0, 40)}`)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Compose (Notepad + Reply) collapsed until needed */}
        {view === 'results' && (
        <div className="mt-10 border-t border-[#242a33] pt-6">
          <button
            onClick={() => setComposeOpen(o => !o)}
            className="w-full flex items-center justify-between text-left group"
          >
            <div>
              <h2 className="text-base font-semibold text-[#e8eaed]">✍️ Compose a post or reply</h2>
              <p className="text-sm text-[#9aa4b2] mt-0.5">
                {intel ? 'Draft a post (tone matched to your scan) or reply to any thread above.' : 'Draft a Reddit / HN post or reply that sounds human.'}
              </p>
            </div>
            <span className={`text-[#9aa4b2] group-hover:text-[#e8eaed] transition-transform ${composeOpen ? 'rotate-180' : ''}`}>
              ▾
            </span>
          </button>

          {composeOpen && (
            <div className="mt-6 space-y-10">
              {/* Notepad */}
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-[#e8eaed]">
                    📝 New post
                    {intel && draftPlatform === 'reddit' && (
                      <span className="ml-2 text-xs font-normal text-[#ff6a33]">tone matched to scan</span>
                    )}
                  </h3>
                  <div className="flex gap-1 bg-[#14171c] border border-[#242a33] rounded-lg p-1">
                    <button
                      onClick={() => setDraftPlatform('reddit')}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${draftPlatform === 'reddit' ? 'bg-[#ff4500] text-white' : 'text-[#9aa4b2] hover:text-[#e8eaed]'}`}
                    >
                      🟠 Reddit
                    </button>
                    <button
                      onClick={() => setDraftPlatform('hn')}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${draftPlatform === 'hn' ? 'bg-[#ff6600] text-white' : 'text-[#9aa4b2] hover:text-[#e8eaed]'}`}
                    >
                      🔶 HN
                    </button>
                    <button
                      onClick={() => setDraftPlatform('pg')}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${draftPlatform === 'pg' ? 'bg-[#3a4250] text-white' : 'text-[#9aa4b2] hover:text-[#e8eaed]'}`}
                    >
                      ✍️ PG
                    </button>
                  </div>
                </div>
                <p className="text-xs text-[#9aa4b2] mt-1">
                  Drop a 2-line idea. We'll draft a {draftPlatform === 'hn' ? 'Hacker News style' : draftPlatform === 'pg' ? 'Paul Graham style' : 'Reddit style'} post that sounds human.
                </p>

                {draftPlatform === 'reddit' && subreddits.length > 0 && (
                  <div className="mt-3">
                    <input
                      type="text"
                      placeholder="Search subreddit…"
                      value={subredditSearch}
                      onChange={e => setSubredditSearch(e.target.value)}
                      className="w-full bg-[#14171c] border border-[#242a33] rounded-lg px-3 py-2 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
                    />
                    {subredditSearch && (
                      <div className="mt-1 border border-[#242a33] rounded-lg bg-[#14171c] shadow-sm max-h-32 overflow-y-auto">
                        {subreddits.filter(s => s.toLowerCase().includes(subredditSearch.toLowerCase())).slice(0, 8).map(s => (
                          <button
                            key={s}
                            onClick={() => { setSubreddit(s); setSubredditSearch(s); }}
                            className="w-full text-left px-3 py-1.5 text-sm hover:bg-[#ff4500]/10 text-[#e8eaed]"
                          >
                            r/{s}
                          </button>
                        ))}
                      </div>
                    )}
                    {subreddit && <p className="mt-1 text-xs text-[#ff6a33]">Posting to r/{subreddit}</p>}
                  </div>
                )}

                <textarea
                  value={idea}
                  onChange={e => setIdea(e.target.value)}
                  placeholder="e.g. I switched from Notion to Obsidian after 6 months, speed killed it for me"
                  rows={3}
                  className="mt-3 w-full bg-[#14171c] border border-[#242a33] rounded-lg px-3 py-2 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60 resize-none"
                />

                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xs text-[#6b7280]">
                    {idea.trim().split(/\s+/).filter(Boolean).length} words
                  </span>
                  <button
                    onClick={generateDraft}
                    disabled={drafting || !idea.trim()}
                    className="bg-[#ff4500] hover:bg-[#ff6a33] text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-colors"
                  >
                    {drafting ? 'Drafting…' : 'Generate post →'}
                  </button>
                </div>

                {draftError && <p className="mt-3 text-sm text-red-400">{draftError}</p>}

                {draft && (
                  <div className="mt-4 border border-[#242a33] rounded-xl p-4 bg-[#14171c]">
                    <p className="whitespace-pre-wrap text-sm text-[#e8eaed] leading-relaxed">
                      {draft.draft}
                    </p>
                    <div className="mt-3 pt-3 border-t border-[#242a33] flex items-center gap-3 text-xs text-[#9aa4b2]">
                      <span>{draft.word_count} words</span>
                      <span className="bg-[#0b0d10] border border-[#242a33] text-[#9aa4b2] px-2 py-0.5 rounded">
                        tone: {draft.tone}
                      </span>
                      <button
                        onClick={copyDraft}
                        className="ml-auto text-[#ff6a33] hover:underline"
                      >
                        {draftCopied ? '✓ Copied!' : 'Copy draft ↗'}
                      </button>
                    </div>

                    {/* Schedule to Reddit */}
                    {draftPlatform === 'reddit' && (
                      <div className="mt-4 pt-4 border-t border-[#242a33]">
                        <p className="text-xs font-medium text-[#9aa4b2] mb-2">📅 Schedule to Reddit via Zernio</p>

                        {(!session || !zernioConnected) ? (
                          <p className="text-xs text-[#9aa4b2]">
                            {!session ? 'Sign in' : 'Connect Zernio'} in{' '}
                            <button onClick={() => setView('settings')} className="text-[#ff6a33] underline">
                              Settings
                            </button>{' '}
                            to schedule this post to Reddit.
                          </p>
                        ) : (
                        <div className="flex gap-2 flex-wrap">
                          <div className="relative">
                            <input
                              type="text"
                              value={subredditSearch || subreddit}
                              onChange={e => { setSubredditSearch(e.target.value); setSubreddit(''); setShowSubredditDropdown(true) }}
                              onFocus={() => setShowSubredditDropdown(true)}
                              onBlur={() => setTimeout(() => setShowSubredditDropdown(false), 150)}
                              placeholder="r/SaaS"
                              className="bg-[#0b0d10] border border-[#242a33] rounded-lg px-3 py-1.5 text-xs text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60 w-36"
                            />
                            {showSubredditDropdown && subreddits.length > 0 && (
                              <div className="absolute z-10 mt-1 w-48 bg-[#14171c] border border-[#242a33] rounded-lg shadow-lg max-h-48 overflow-y-auto">
                                {subreddits
                                  .filter(s => s.toLowerCase().includes((subredditSearch || subreddit).toLowerCase()))
                                  .map(s => (
                                    <button
                                      key={s}
                                      onMouseDown={() => { setSubreddit(s); setSubredditSearch(''); setShowSubredditDropdown(false) }}
                                      className="w-full text-left px-3 py-2 text-xs hover:bg-[#ff4500]/10 hover:text-[#ff6a33] text-[#e8eaed]"
                                    >
                                      r/{s}
                                    </button>
                                  ))}
                              </div>
                            )}
                          </div>
                          <input
                            type="datetime-local"
                            value={scheduleTime}
                            onChange={e => setScheduleTime(e.target.value)}
                            className="bg-[#0b0d10] border border-[#242a33] rounded-lg px-3 py-1.5 text-xs text-[#e8eaed] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
                          />
                          <button
                            onClick={schedulePost}
                            disabled={scheduling}
                            className="bg-[#ff4500] hover:bg-[#ff6a33] text-white px-4 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors"
                          >
                            {scheduling ? 'Scheduling…' : scheduleTime ? 'Schedule →' : 'Post now →'}
                          </button>
                        </div>
                        )}
                        {scheduleError && <p className="mt-2 text-xs text-red-400">{scheduleError}</p>}
                        {scheduleResult && (
                          <p className="mt-2 text-xs text-green-400">
                            ✓ {scheduleResult.status === 'scheduled' ? 'Scheduled!' : 'Posted!'} ID: {scheduleResult.post_id}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Comment generator */}
              <div ref={commentRef}>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-[#e8eaed]">💬 Reply to a post</h3>
                  <div className="flex gap-1 bg-[#14171c] border border-[#242a33] rounded-lg p-1">
                    <button
                      onClick={() => setCommentPlatform('reddit')}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${commentPlatform === 'reddit' ? 'bg-[#ff4500] text-white' : 'text-[#9aa4b2] hover:text-[#e8eaed]'}`}
                    >
                      🟠 Reddit
                    </button>
                    <button
                      onClick={() => setCommentPlatform('hn')}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${commentPlatform === 'hn' ? 'bg-[#ff6600] text-white' : 'text-[#9aa4b2] hover:text-[#e8eaed]'}`}
                    >
                      🔶 HN
                    </button>
                  </div>
                </div>
                <p className="text-xs text-[#9aa4b2] mt-1">
                  Paste a post + what you want to say. We draft a {commentPlatform === 'hn' ? 'Hacker News style' : 'Reddit style'} comment that fits.
                </p>

                <label className="block mt-4 text-xs font-medium text-[#9aa4b2]">
                  The post
                </label>
                <textarea
                  value={postText}
                  onChange={e => setPostText(e.target.value)}
                  placeholder="Paste the post you want to reply to…"
                  rows={4}
                  className="mt-1 w-full bg-[#14171c] border border-[#242a33] rounded-lg px-3 py-2 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60 resize-none"
                />

                <label className="mt-3 flex items-center gap-1.5 text-xs font-medium text-[#9aa4b2]">
                  What you want to say
                  <span className="relative group inline-flex items-center">
                    <span
                      className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-[#3a4250] text-[#9aa4b2] text-[10px] font-bold cursor-help hover:bg-[#242a33]"
                      aria-label="help"
                    >
                      ?
                    </span>
                    <span className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 hidden group-hover:block whitespace-nowrap bg-[#242a33] text-[#e8eaed] text-xs font-normal rounded px-2 py-1 shadow-lg z-10">
                      Explain your comment in 1–2 lines
                    </span>
                  </span>
                </label>
                <textarea
                  value={intent}
                  onChange={e => setIntent(e.target.value)}
                  placeholder="e.g. agree, mention I switched to Obsidian and it loads instantly"
                  rows={2}
                  className="mt-1 w-full bg-[#14171c] border border-[#242a33] rounded-lg px-3 py-2 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60 resize-none"
                />

                <div className="mt-2 flex items-center justify-end">
                  <button
                    onClick={generateComment}
                    disabled={commenting || !postText.trim() || !intent.trim()}
                    className="bg-[#ff4500] hover:bg-[#ff6a33] text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-colors"
                  >
                    {commenting ? 'Drafting…' : 'Generate comment →'}
                  </button>
                </div>

                {commentError && <p className="mt-3 text-sm text-red-400">{commentError}</p>}

                {comment && (
                  <div className="mt-4 border border-[#242a33] rounded-xl p-4 bg-[#14171c]">
                    <p className="whitespace-pre-wrap text-sm text-[#e8eaed] leading-relaxed">
                      {comment.draft}
                    </p>
                    <div className="mt-3 pt-3 border-t border-[#242a33] flex items-center gap-3 text-xs text-[#9aa4b2]">
                      <span>{comment.word_count} words</span>
                      <span className="bg-[#0b0d10] border border-[#242a33] text-[#9aa4b2] px-2 py-0.5 rounded">
                        tone: {comment.tone}
                      </span>
                      <button
                        onClick={copyComment}
                        className="ml-auto text-[#ff6a33] hover:underline"
                      >
                        {commentCopied ? '✓ Copied!' : 'Copy comment ↗'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        )}
      </div>
      )}
      </main>
    </div>
  )
}
