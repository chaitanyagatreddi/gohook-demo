import { useState, useEffect, useRef } from 'react'
import Board, { type BoardCard } from './Board'
import Graph from './Graph'
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
  freshness?: string
}

type Tab = 'pricing' | 'complaints' | 'comparisons' | 'praise' | 'quotes'

const TAB_LABELS: Record<Tab, string> = {
  pricing: '💰 Pricing',
  complaints: '😤 Complaints',
  comparisons: '⚖️ Comparisons',
  praise: '💚 Praise',
  quotes: '💬 Quotes',
}

function ResultCard({ item, onReply, onAdd, added }: { item: ResultItem; onReply?: (item: ResultItem) => void; onAdd?: (item: ResultItem) => void; added?: boolean }) {
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
            onClick={() => onReply(item)}
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

type AskSource = {
  n: number
  title: string
  subreddit_name_prefixed: string
  selftext: string
  permalink: string
  url: string
}
type AskTurn = { question: string; answer: string; queries_used: string[]; sources: AskSource[] }

// Turn "[S3]" citations into links to the matching Reddit thread, and "**x**" into bold
function renderAnswer(answer: string, sources: AskSource[]) {
  return answer.split(/(\[S?\d+\]|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
    }
    const m = part.match(/^\[S?(\d+)\]$/)
    const src = m && sources.find(s => s.n === Number(m[1]))
    if (!src) return <span key={i}>{part.replace(/^#+\s*/gm, '')}</span>
    return (
      <a key={i} href={src.url} target="_blank" rel="noopener noreferrer" className="text-[#ff6a33] hover:underline" title={src.title}>
        {part}
      </a>
    )
  })
}

type Draft = { draft: string; word_count: number; tone: string }
type QuestionSource = { n: number; title: string; url: string; site?: string; date?: string; permalink?: string; subreddit_name_prefixed?: string; selftext?: string }
type QuestionValidation = { checked: number; verified: number; communities: number; score: number; coverage: number; retried: boolean; passed: boolean; mode?: 'simple' | 'strict'; top_relevance?: number }
type QuestionClaim = { text: string; sources: number[] }
type QuestionCheck = { label: string; passed: boolean; detail: string }
type QuestionRun = { passed: boolean; claims: QuestionClaim[]; attempts: { stage: string; passed: boolean; retried?: boolean }[]; checks: QuestionCheck[] }
type QuestionAnswer = { question: string; answer?: string; sources?: QuestionSource[]; validation?: QuestionValidation; run?: QuestionRun; layer?: number; parentScore?: number; scoreDelta?: number }
type QuestionMemory = QuestionAnswer & { saved_at?: string }
type QuestionStageKey = 'understand' | 'research' | 'filter' | 'validate' | 'refine' | 'answer' | 'correct'
type QuestionStage = { state: 'idle' | 'active' | 'passed' | 'review'; detail: string }
type QuestionProgress = { questionIndex: number; running: boolean; steps: Record<QuestionStageKey, QuestionStage> }
type ScottAdminUser = { email: string; enabled: boolean }

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
  const [freshness, setFreshness] = useState<'any' | 'day' | 'week' | 'month'>('any')
  const [copied, setCopied] = useState(false)

  // View + Kanban board
  const [view, setView] = useState<'results' | 'questions' | 'board' | 'graph' | 'settings'>(() => {
    // Coming back from signing into Reddit: land on the Graph page.
    try {
      return new URLSearchParams(window.location.search).get('reddit') === 'connected' ? 'graph' : 'results'
    } catch {
      return 'results'
    }
  })

  // Tidy the address bar once we've read the flag.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('reddit') === 'connected') {
      params.delete('reddit')
      const rest = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash)
    }
  }, [])
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

  // "Ask Reddit" history: newest search first; each search is a question + its follow-ups.
  // Kept on this device so earlier searches survive a reload and can still be sent to the Board.
  const [searches, setSearches] = useState<AskTurn[][]>(() => {
    try {
      const raw = localStorage.getItem('gohook_searches')
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('gohook_searches', JSON.stringify(searches.slice(0, 20)))
    } catch { /* storage full or blocked */ }
  }, [searches])
  const turns = searches[0] ?? []
  const [followUp, setFollowUp] = useState('')

  function addQuestionToBoard(turn: AskTurn) {
    const id = `ask::${turn.question}::${turn.answer.slice(0, 40)}`
    tellGraphSaved(turn.sources.map(src => ({
      title: src.title,
      selftext: src.selftext,
      permalink: src.permalink,
      url: src.url,
      subreddit_name_prefixed: src.subreddit_name_prefixed,
    })))
    setBoard(prev => (prev.some(c => c.id === id) ? prev : [
      ...prev,
      {
        id,
        title: turn.question,
        text: turn.answer.replace(/\*\*/g, ''),
        source_url: turn.sources[0]?.url ?? '',
        subreddit: `${turn.sources.length} threads`,
        reddit_score: 0,
        origin: 'question',
        column: 'new',
      },
    ]))
  }

  function addToBoard(item: ResultItem, origin: string) {
    const id = `${item.source_url}::${item.text.slice(0, 40)}`
    tellGraphSaved([{
      title: item.text.slice(0, 120),
      selftext: item.text,
      url: item.source_url,
      permalink: item.source_url,
      subreddit_name_prefixed: item.subreddit,
      score: item.reddit_score,
    }])
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

  // Board saves also belong in the graph, under "Saved". Quiet on failure —
  // a graph hiccup must never stop something being saved to the Board.
  async function tellGraphSaved(threads: { title?: string; selftext?: string; permalink?: string; url?: string; subreddit_name_prefixed?: string; score?: number }[]) {
    const real = threads.filter(t => (t.permalink || t.url || '').includes('/comments/'))
    if (real.length === 0) return
    try {
      const { data } = await supabase.auth.getSession()
      if (!data.session) return   // signed out: nothing to attach it to
      await fetch(`${API}/graph/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify({ threads: real }),
      })
    } catch { /* the Board save already happened; leave it */ }
  }

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
  const [questionMemory, setQuestionMemory] = useState<QuestionMemory[]>([])
  const [questionMemoryOpen, setQuestionMemoryOpen] = useState(false)
  const [questionBatchError, setQuestionBatchError] = useState('')
  const [answeringIndex, setAnsweringIndex] = useState<number | null>(null)
  const [answerErrors, setAnswerErrors] = useState<Record<number, string>>({})
  const [pickedQuestions, setPickedQuestions] = useState<Set<number>>(new Set())
  const [questionProgress, setQuestionProgress] = useState<QuestionProgress | null>(null)
  const [scottAvailable, setScottAvailable] = useState(false)
  const [scottEnabled, setScottEnabled] = useState(() => {
    try { return localStorage.getItem('gohook_scott_enabled') !== 'false' } catch { return true }
  })
  const [scottAdminVisible, setScottAdminVisible] = useState(false)
  const [scottAdminUsers, setScottAdminUsers] = useState<ScottAdminUser[]>([])
  const [scottAdminEmail, setScottAdminEmail] = useState('')
  const [scottAdminBusy, setScottAdminBusy] = useState('')
  const [scottAdminError, setScottAdminError] = useState('')
  const [scottAdminNotice, setScottAdminNotice] = useState('')
  const scottActive = scottAvailable && scottEnabled

  function toggleQuestion(index: number) {
    setPickedQuestions(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  function addPickedToBoard() {
    const picked = [...pickedQuestions].sort((a, b) => a - b)
    setBoard(prev => {
      const next = [...prev]
      for (const index of picked) {
        const item = questionBatch[index]
        if (!item) continue
        const id = `batch::${item.question}`
        if (next.some(c => c.id === id)) continue
        tellGraphSaved((item.sources ?? []).map(src => ({
          title: src.title,
          selftext: src.selftext,
          permalink: src.permalink,
          url: src.url,
          subreddit_name_prefixed: src.subreddit_name_prefixed,
        })))
        next.push({
          id,
          title: item.question,
          text: item.answer ?? '',
          source_url: item.sources?.[0]?.url ?? '',
          subreddit: item.sources?.length ? `${item.sources.length} sources` : 'batch question',
          reddit_score: 0,
          origin: 'question',
          column: 'new',
        })
      }
      return next
    })
    setPickedQuestions(new Set())
  }

  async function createQuestionBatch() {
    const questions = questionBrief.split('\n').map(question => question.trim()).filter(Boolean)
    setQuestionBatchError('')
    if (questions.length < 1 || questions.length > 3) {
      setQuestionBatchError('Enter 1 to 3 questions, one per line.')
      return
    }
    const items = questions.map(question => ({ question, layer: 1 }))
    await rememberQuestions(items)
    const startIndex = questionBatch.length
    setQuestionProgress(null)
    setQuestionBatch(previous => [...previous, ...items])
    if (items.length === 1) await generateAnswer(startIndex, items[0])
  }

  async function rememberQuestions(items: QuestionAnswer[]) {
    if (!session) return
    try {
      const headers = await authHeaders()
      await Promise.all(items.map(item => fetch(`${API}/question-memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ question: item.question }),
      })))
      const savedAt = new Date().toISOString()
      setQuestionMemory(prev => [
        ...items.map(item => ({ ...item, saved_at: savedAt })),
        ...prev.filter(entry => !items.some(item => item.question === entry.question)),
      ].slice(0, 20))
    } catch {
      // The question can still run when question memory is temporarily unavailable.
    }
  }

  async function generateAnswer(index: number, overrideItem?: QuestionAnswer) {
    const item = overrideItem ?? questionBatch[index]
    if (!item) return
    setAnsweringIndex(index)
    setAnswerErrors(prev => ({ ...prev, [index]: '' }))
    const scottVisibleForRun = scottEnabled && await refreshScottAccess()
    setQuestionProgress(scottVisibleForRun ? {
        questionIndex: index,
        running: true,
        steps: {
          understand: { state: 'active', detail: 'Reading the question' },
          research: { state: 'idle', detail: 'Waiting for the evidence target' },
          filter: { state: 'idle', detail: 'Waiting for search results' },
          validate: { state: 'idle', detail: 'Waiting for verified threads' },
          refine: { state: 'idle', detail: 'Waiting for the first evidence score' },
          answer: { state: 'idle', detail: 'Waiting for evidence' },
          correct: { state: 'idle', detail: 'Waiting for answer validation' },
        },
      } : null)
    try {
      const auth = await authHeaders()
      const res = await fetch(`${API}/question-answer-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ question: item.question }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Answer generation failed')
      }
      if (!res.body) throw new Error('Live question progress is unavailable')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let receivedResult = false
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          const line = block.split('\n').find(entry => entry.startsWith('data: '))
          if (!line) continue
          const event = JSON.parse(line.slice(6))
          if (event.type === 'stage' && scottVisibleForRun) {
            const stage = event.stage as QuestionStageKey
            setQuestionProgress(prev => prev ? {
              ...prev,
              steps: { ...prev.steps, [stage]: { state: event.status, detail: event.detail } },
            } : prev)
          } else if (event.type === 'result') {
            const data = event.data
            receivedResult = true
            setQuestionBatch(prev => prev.map((entry, entryIndex) => entryIndex === index ? {
              ...entry,
              answer: data.answer,
              sources: data.sources ?? [],
              validation: data.validation,
              run: data.run,
              scoreDelta: entry.parentScore === undefined || !data.validation ? undefined : data.validation.score - entry.parentScore,
            } : entry))
            if (session) {
              const memory: QuestionMemory = {
                question: item.question,
                answer: data.answer,
                sources: data.sources ?? [],
                saved_at: new Date().toISOString(),
              }
              setQuestionMemory(prev => [memory, ...prev.filter(entry => entry.question !== memory.question)].slice(0, 20))
            }
          } else if (event.type === 'error') {
            throw new Error(event.message || 'Answer generation failed')
          }
        }
        if (done) break
      }
      if (!receivedResult) throw new Error('Answer generation ended before completion')
    } catch (e: unknown) {
      setAnswerErrors(prev => ({ ...prev, [index]: e instanceof Error ? e.message : 'Something went wrong' }))
    } finally {
      setAnsweringIndex(null)
      setQuestionProgress(prev => prev ? { ...prev, running: false } : prev)
    }
  }

  async function runNextLayer(index: number) {
    const item = questionBatch[index]
    if (!item?.answer || !item.validation || (item.layer ?? 1) >= 3) return
    setAnsweringIndex(index)
    setAnswerErrors(prev => ({ ...prev, [index]: '' }))
    try {
      const auth = await authHeaders()
      const failedChecks = (item.run?.checks ?? []).filter(check => !check.passed).map(check => `${check.label}: ${check.detail}`)
      const response = await fetch(`${API}/question-follow-up`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ question: item.question, answer: item.answer, failed_checks: failedChecks }),
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || 'Could not create the next layer')
      }
      const data = await response.json()
      const nextItem: QuestionAnswer = {
        question: data.question,
        layer: (item.layer ?? 1) + 1,
        parentScore: item.validation.score,
      }
      const nextIndex = questionBatch.length
      setQuestionBatch(prev => [...prev, nextItem])
      setAnsweringIndex(null)
      await generateAnswer(nextIndex, nextItem)
    } catch (error: unknown) {
      setAnswerErrors(prev => ({ ...prev, [index]: error instanceof Error ? error.message : 'Could not create the next layer' }))
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

  // Whatever is already on the Board was saved before the graph knew about it.
  // Push those across once, after sign-in, then never again on this device.
  useEffect(() => {
    if (!session || board.length === 0) return
    try {
      if (localStorage.getItem('gohook_board_backfilled') === '1') return
    } catch { return }
    const threads = board
      .filter(c => (c.source_url || '').includes('/comments/'))
      .map(c => ({
        title: (c.title || c.text || '').slice(0, 120),
        selftext: c.text || '',
        permalink: c.source_url,
        url: c.source_url,
        subreddit_name_prefixed: c.subreddit || '',
        score: c.reddit_score || 0,
      }))
    if (threads.length === 0) return
    tellGraphSaved(threads).then(() => {
      try { localStorage.setItem('gohook_board_backfilled', '1') } catch { /* blocked */ }
    })
  }, [session, board.length])
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

  useEffect(() => {
    if (!session) {
      setQuestionMemory([])
      return
    }
    authHeaders().then(async headers => {
      try {
        const response = await fetch(`${API}/question-history`, { headers })
        const data = response.ok ? await response.json() : { questions: [] }
        const saved = data.questions ?? []
        setQuestionMemory(saved)
        setQuestionBatch(current => current.length > 0 ? current : saved.map((item: QuestionMemory) => ({
          question: item.question,
          answer: item.answer,
          sources: item.sources ?? [],
          layer: 1,
        })))
      } catch {
        setQuestionMemory([])
      }
    })
  }, [session])

  useEffect(() => {
    if (!session) {
      setScottAvailable(false)
      setScottAdminVisible(false)
      return
    }
    void refreshScottAccess()
    void refreshScottAdmin()
  }, [session])

  async function refreshScottAccess() {
    const headers = await authHeaders()
    if (!headers.Authorization) {
      setScottAvailable(false)
      return false
    }
    try {
      const response = await fetch(`${API}/scott-access`, { headers })
      const data = response.ok ? await response.json() : { enabled: false }
      const enabled = Boolean(data.enabled)
      setScottAvailable(enabled)
      return enabled
    } catch {
      setScottAvailable(false)
      return false
    }
  }

  async function refreshScottAdmin() {
    const headers = await authHeaders()
    if (!headers.Authorization) return
    try {
      const response = await fetch(`${API}/scott-admin/users`, { headers })
      if (!response.ok) {
        setScottAdminVisible(false)
        return
      }
      const data = await response.json()
      setScottAdminUsers(data.users ?? [])
      setScottAdminVisible(true)
    } catch {
      setScottAdminVisible(false)
    }
  }

  async function updateScottAccess(email: string, enabled: boolean) {
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail) return
    setScottAdminBusy(normalizedEmail)
    setScottAdminError('')
    setScottAdminNotice('')
    try {
      const headers = await authHeaders()
      const response = await fetch(`${API}/scott-admin/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ email: normalizedEmail, enabled }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Could not update access')
      if (data.invited) setScottAdminNotice(`Invite sent to ${normalizedEmail}`)
      setScottAdminUsers(prev => {
        const exists = prev.some(user => user.email === normalizedEmail)
        return exists
          ? prev.map(user => user.email === normalizedEmail ? { ...user, enabled } : user)
          : [...prev, { email: normalizedEmail, enabled }]
      })
      setScottAdminEmail('')
      if (session?.user.email?.toLowerCase() === normalizedEmail) await refreshScottAccess()
    } catch (error: unknown) {
      setScottAdminError(error instanceof Error ? error.message : 'Could not update access')
    } finally {
      setScottAdminBusy('')
    }
  }

  async function inviteScottUser(email: string) {
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail) return
    setScottAdminBusy(normalizedEmail)
    setScottAdminError('')
    setScottAdminNotice('')
    try {
      const headers = await authHeaders()
      const response = await fetch(`${API}/scott-admin/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ email: normalizedEmail }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Could not send invite')
      setScottAdminUsers(prev => [...prev, { email: normalizedEmail, enabled: true }])
      setScottAdminEmail('')
      setScottAdminNotice(`Invite sent to ${normalizedEmail}`)
    } catch (error: unknown) {
      setScottAdminError(error instanceof Error ? error.message : 'Could not send invite')
    } finally {
      setScottAdminBusy('')
    }
  }

  async function deleteScottUser(email: string) {
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail || !window.confirm(`Delete the GoHook account for ${normalizedEmail}?`)) return
    setScottAdminBusy(normalizedEmail)
    setScottAdminError('')
    setScottAdminNotice('')
    try {
      const headers = await authHeaders()
      const response = await fetch(`${API}/scott-admin/users/${encodeURIComponent(normalizedEmail)}`, {
        method: 'DELETE',
        headers,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Could not delete account')
      setScottAdminUsers(prev => prev.filter(user => user.email !== normalizedEmail))
      setScottAdminNotice(`Account deleted for ${normalizedEmail}`)
    } catch (error: unknown) {
      setScottAdminError(error instanceof Error ? error.message : 'Could not delete account')
    } finally {
      setScottAdminBusy('')
    }
  }

  function toggleScott() {
    const enabled = !scottEnabled
    setScottEnabled(enabled)
    try { localStorage.setItem('gohook_scott_enabled', String(enabled)) } catch { /* blocked */ }
    if (!enabled) setQuestionProgress(null)
  }

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

  async function signInWithGoogle() {
    setAuthError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    if (error) setAuthError(error.message)
  }

  async function signOut() {
    await supabase.auth.signOut()
    setShowAuthGate(true)
    setView('results')
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
  const [postUrl, setPostUrl] = useState('')
  const [intent, setIntent] = useState('')
  const [commenting, setCommenting] = useState(false)
  const [comment, setComment] = useState<Draft | null>(null)
  const [commentError, setCommentError] = useState('')
  const [commentCopied, setCommentCopied] = useState(false)
  const [commentPlatform, setCommentPlatform] = useState<'reddit' | 'hn'>('reddit')
  const [postFetched, setPostFetched] = useState(false)
  const [postPreview, setPostPreview] = useState('')
  const [fetchingPost, setFetchingPost] = useState(false)

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

  async function askReddit(question: string, prior: AskTurn[]): Promise<AskTurn> {
    const history = prior.flatMap(t => [
      { role: 'user', content: t.question },
      { role: 'assistant', content: t.answer },
    ])
    const res = await fetch(`${API}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history, sources: prior.at(-1)?.sources ?? [] }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.detail || 'Could not answer that')
    }
    const data = await res.json()
    return { question, answer: data.answer, queries_used: data.queries_used, sources: data.sources }
  }

  async function doFollowUp() {
    const q = followUp.trim()
    if (!q || loading) return
    setLoading(true)
    setError('')
    try {
      const turn = await askReddit(q, turns)
      setSearches(prev => [[...(prev[0] ?? []), turn], ...prev.slice(1)])
      setFollowUp('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  async function doSearch(q: string, expand = false) {
    if (!q.trim()) return
    if (!session && searchCount >= FREE_SEARCH_LIMIT) {
      setShowAuthGate(true)
      return
    }
    setLoading(true)
    setError('')
    if (!expand) setIntel(null)
    try {
      // Any question gets a cited answer (added on top of earlier searches); comparisons also get the 5 tabs
      if (!expand) {
        const turn = await askReddit(q, [])
        setSearches(prev => [[turn], ...prev].slice(0, 20))
      }
      if (expand || COMPARISON_PATTERN.test(q)) {
        const res = await fetch(`${API}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, expand, freshness }),
        })
        if (!res.ok) {
          const err = await res.json()
          throw new Error(err.detail || 'Search failed')
        }
        setIntel(await res.json())
      }
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
    if (!postFetched || !postUrl.trim() || !intent.trim()) return
    setCommenting(true)
    setCommentError('')
    setComment(null)
    try {
      const res = await fetch(`${API}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_url: postUrl, intent, platform: commentPlatform }),
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

  async function fetchPost() {
    if (!postUrl.trim()) return
    setFetchingPost(true)
    setPostFetched(false)
    setPostPreview('')
    setCommentError('')
    try {
      const res = await fetch(`${API}/reddit-post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_url: postUrl }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not fetch that post')
      setPostPreview(data.preview || '')
      setPostFetched(true)
    } catch (e: unknown) {
      setCommentError(e instanceof Error ? e.message : 'Could not fetch that post')
    } finally {
      setFetchingPost(false)
    }
  }

  function handleReply(item: ResultItem) {
    setPostUrl(item.source_url)
    setPostFetched(false)
    setPostPreview('')
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
  const questionWorkflowItem = questionProgress
    ? questionBatch[questionProgress.questionIndex]
    : [...questionBatch].reverse().find(item => item.run) ?? questionBatch[0]
  const questionWorkflowSteps = [
    {
      number: '01',
      title: 'Understand question',
      detail: questionProgress?.steps.understand.detail ?? (questionWorkflowItem?.validation ? 'Question and evidence target identified' : 'Waiting for a question'),
      state: questionProgress?.steps.understand.state ?? (questionWorkflowItem?.validation ? 'passed' : 'idle'),
    },
    {
      number: '02',
      title: 'Search Reddit',
      detail: questionProgress?.steps.research.detail ?? (questionWorkflowItem?.validation
        ? `${questionWorkflowItem.validation.verified} verified threads across ${questionWorkflowItem.validation.communities} communities`
        : 'Waiting for an evidence target'),
      state: questionProgress?.steps.research.state ?? (questionWorkflowItem?.validation ? (questionWorkflowItem.validation.passed ? 'passed' : 'review') : 'idle'),
    },
    {
      number: '03',
      title: 'Filter threads',
      detail: questionProgress?.steps.filter.detail ?? (questionWorkflowItem?.validation ? `${questionWorkflowItem.validation.checked} candidates checked` : 'Duplicates and invalid links will be removed'),
      state: questionProgress?.steps.filter.state ?? (questionWorkflowItem?.validation ? (questionWorkflowItem.validation.verified ? 'passed' : 'review') : 'idle'),
    },
    {
      number: '04',
      title: 'Score evidence',
      detail: questionProgress?.steps.validate.detail ?? (questionWorkflowItem?.validation ? `Evidence score ${questionWorkflowItem.validation.score}/100 · coverage ${questionWorkflowItem.validation.coverage}%` : 'Relevance, diversity and coverage will be scored'),
      state: questionProgress?.steps.validate.state ?? (questionWorkflowItem?.validation ? (questionWorkflowItem.validation.passed ? 'passed' : 'review') : 'idle'),
    },
    {
      number: '05',
      title: 'Refine research',
      detail: questionProgress?.steps.refine.detail ?? (questionWorkflowItem?.validation?.retried ? 'A focused second search was completed' : questionWorkflowItem?.validation ? 'Initial evidence did not need refinement' : 'Weak evidence will trigger a focused retry'),
      state: questionProgress?.steps.refine.state ?? (questionWorkflowItem?.validation ? 'passed' : 'idle'),
    },
    {
      number: '06',
      title: 'Map claims',
      detail: questionProgress?.steps.answer.detail ?? (questionWorkflowItem?.run ? `${questionWorkflowItem.run.claims.length} source-backed claims mapped` : 'Answer will be mapped to sources'),
      state: questionProgress?.steps.answer.state ?? (questionWorkflowItem?.run ? (questionWorkflowItem.run.attempts.find(a => a.stage === 'answer')?.passed ? 'passed' : 'review') : 'idle'),
    },
    {
      number: '07',
      title: 'Correct and check',
      detail: questionProgress?.steps.correct.detail ?? (questionWorkflowItem?.run?.attempts.some(a => a.stage === 'answer correction')
        ? `Answer correction ${questionWorkflowItem.run.attempts.find(a => a.stage === 'answer correction')?.passed ? 'passed' : 'needs review'}`
        : questionWorkflowItem?.run?.passed ? 'No correction needed' : 'Final check will run'),
      state: questionProgress?.steps.correct.state ?? (questionWorkflowItem?.run ? (questionWorkflowItem.run.passed ? 'passed' : 'review') : 'idle'),
    },
  ] as const

  return (
    <div className="min-h-screen bg-[#0a0b0d] text-[#f1f2f4] flex items-start">
      {/* Left rail. Layout borrowed from GTM Predictor; GoHook colours. */}
      {!(showAuthGate && !session) && (
        <aside className="fixed bottom-0 left-0 right-0 z-30 h-16 w-full flex flex-none flex-row bg-[#101114] border-t border-[#272a30] md:sticky md:top-0 md:h-screen md:w-60 md:flex-col md:border-t-0 md:border-r md:py-5">
          <div className="hidden md:flex px-5 mb-8 flex-col items-start">
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 32 32" className="w-[22px] h-[22px] flex-none" aria-hidden="true">
                <g stroke="#ff4500" strokeWidth="2" fill="none">
                  <path d="M16 9v8M8 23v-6h16v6" />
                  <rect x="12" y="3" width="8" height="7" rx="1" />
                  <rect x="4" y="22" width="8" height="7" rx="1" />
                  <rect x="20" y="22" width="8" height="7" rx="1" />
                </g>
              </svg>
              <h1 className="hidden md:block text-[17px] font-semibold tracking-[-0.03em]">GoHook</h1>
            </div>
            <p className="hidden md:block text-xs text-[#747982] mt-2 leading-snug">
              Your knowledge graph for Reddit.
            </p>
          </div>
          <nav className="flex-1 overflow-y-auto px-2 md:px-3 flex flex-row md:flex-col gap-1.5">
            {([
              { key: 'results', label: 'Results', icon: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></> },
              { key: 'board', label: 'Board', icon: <><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="11" rx="1" /><rect x="17" y="4" width="4" height="7" rx="1" /></> },
              { key: 'questions', label: 'Questions', icon: <><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></> },
              { key: 'graph', label: 'Graph', icon: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="7" r="2.5" /><circle cx="12" cy="17" r="2.5" /><path d="M8 7.5l8 -0.5M7.2 8.2L11 14.8M16.8 9.2L13 14.8" /></> },
              { key: 'settings', label: 'Settings', icon: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></> },
            ] as const).map(item => (
              <button
                key={item.key}
                onClick={() => setView(item.key)}
                title={item.label}
                className={`group relative flex flex-1 md:flex-none flex-col md:flex-row items-center justify-center md:justify-start gap-1 md:gap-3 px-2 md:px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${view === item.key ? 'bg-[#1c1e23] text-[#f7f7f8] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]' : 'text-[#858b95] hover:text-[#e8eaed] hover:bg-[#191b1f]'}`}
              >
                {view === item.key && <span className="hidden md:block absolute left-0 h-4 w-0.5 rounded-full bg-[#ff6a33]" aria-hidden="true" />}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="w-[17px] h-[17px] flex-none">{item.icon}</svg>
                <span className="text-[10px] leading-none md:text-sm md:inline">
                  {item.label}
                  {item.key === 'board' && board.length > 0 && <span className="opacity-80"> ({board.length})</span>}
                </span>
              </button>
            ))}
          </nav>
          {session && (
            <div className="px-2 pb-2 md:px-3 md:pb-3">
              <button
                type="button"
                onClick={signOut}
                title="Log out"
                className="flex w-full items-center justify-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-[#858b95] transition-colors hover:bg-[#191b1f] hover:text-[#e8eaed] md:justify-start"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-[17px] w-[17px] flex-none">
                  <path d="M10 17l5-5-5-5" />
                  <path d="M15 12H3" />
                  <path d="M21 19V5a2 2 0 0 0-2-2h-6" />
                </svg>
                <span className="hidden md:inline">Log out</span>
              </button>
            </div>
          )}
        </aside>
      )}

      <main className="flex-1 min-w-0 pb-16 md:pb-0">
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
      ) : view === 'graph' ? (
        <Graph signedIn={!!session} onSignIn={() => setShowAuthGate(true)} />
      ) : (
      <div className={`${view === 'board' || view === 'questions' ? 'max-w-6xl' : 'max-w-3xl'} mx-auto px-4 py-10`}>
        {/* Hero + search bar */}
        {!intel && !loading && searches.length === 0 && view === 'results' && (
          <div className="text-center mb-6">
            <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight leading-tight">
              Your knowledge graph<br />
              <span className="bg-gradient-to-r from-[#ff4500] to-[#ff6a33] bg-clip-text text-transparent">
                for Reddit.
              </span>
            </h2>
          </div>
        )}

        {view === 'results' && <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && doSearch(query)}
            placeholder="Ask a Reddit question…"
            className="flex-1 min-w-0 bg-[#14171c] border border-[#242a33] rounded-xl px-4 py-3 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
          />
          <select
            value={freshness}
            onChange={e => setFreshness(e.target.value as typeof freshness)}
            className="bg-[#14171c] border border-[#242a33] rounded-xl px-3 py-3 text-sm text-[#e8eaed] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
            aria-label="Freshness"
          >
            <option value="any">Any age</option>
            <option value="day">Past 24 hours</option>
            <option value="week">Past week</option>
            <option value="month">Past month</option>
          </select>
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
        {view === 'results' && loading && searches.length === 0 && (
          <div className="mt-8 space-y-3 animate-pulse">
            <div className="h-14 rounded-xl bg-[#14171c] border border-[#242a33]" />
            {[0, 1, 2].map(i => (
              <div key={i} className="h-20 rounded-xl bg-[#14171c] border border-[#242a33]" />
            ))}
          </div>
        )}

        {view === 'board' && <Board board={board} setBoard={setBoard} onGoToResults={() => setView('results')} />}

        {view === 'questions' && (
          <div className={`max-w-7xl mx-auto grid gap-6 items-start ${scottActive ? 'lg:grid-cols-[minmax(0,1fr)_380px]' : 'grid-cols-1'}`}>
            <div className="min-w-0">
            <div className="border-b border-[#242a33] pb-6">
              <div>
                <h2 className="text-3xl font-bold tracking-tight">Batch questions</h2>
                <p className="text-sm text-[#9aa4b2] mt-2">Enter 1 to 3 questions, one per line. Generate each answer individually.</p>
              </div>
              <button
                onClick={() => setQuestionMemoryOpen(open => !open)}
                className="mt-4 inline-flex w-auto border border-[#ff4500] bg-transparent hover:bg-[#ff4500]/10 text-[#ff6a33] px-4 py-2 rounded-xl text-sm font-semibold transition-colors"
              >
                {questionMemoryOpen ? 'Close memory' : `Question memory${questionMemory.length ? ` · ${questionMemory.length}` : ''}`}
              </button>
            </div>
            {questionMemoryOpen && (
              <section className="mt-6 rounded-2xl border border-[#242a33] bg-[#14171c] p-5">
                <h3 className="text-sm font-semibold text-[#e8eaed]">Question memory</h3>
                {questionMemory.length === 0 ? (
                  <p className="mt-2 text-sm text-[#9aa4b2]">No completed questions saved yet.</p>
                ) : (
                  <div className="mt-4 space-y-3">
                    {questionMemory.map((item, index) => (
                      <article key={`${item.question}-${item.saved_at ?? index}`} className="rounded-xl border border-[#242a33] bg-[#0d0f13] p-4">
                        <h3 className="text-sm font-semibold text-[#e8eaed]">{item.question}</h3>
                        {item.answer && <p className="mt-2 text-sm leading-relaxed text-[#9aa4b2] whitespace-pre-wrap">{renderAnswer(item.answer, (item.sources ?? []) as unknown as AskSource[])}</p>}
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}
            <div className="mt-6 rounded-2xl border border-[#242a33] bg-[#14171c] p-5 shadow-[0_16px_40px_rgba(0,0,0,0.16)]">
              <textarea
                value={questionBrief}
                onChange={e => setQuestionBrief(e.target.value)}
                rows={5}
                placeholder={'What problem are users solving?\nWhat do they compare?\nWhy do they switch?'}
                className="w-full min-h-[150px] sm:min-h-0 bg-[#0b0d10] border border-[#242a33] rounded-xl px-4 py-3 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60 resize-none"
              />
              <div className="mt-4 flex justify-end">
                <button
                  onClick={createQuestionBatch}
                  disabled={!questionBrief.trim()}
                  className="w-full sm:w-auto min-h-12 bg-[#ff4500] hover:bg-[#ff6a33] text-white px-6 py-3 rounded-xl text-sm font-semibold shadow-[0_8px_20px_rgba(255,69,0,0.22)] disabled:opacity-70 disabled:cursor-not-allowed transition-colors"
                >
                    {questionBrief.split('\n').map(question => question.trim()).filter(Boolean).length === 1 ? 'Start question' : 'Create question batch'}
                </button>
              </div>
            </div>
            {questionBatchError && <p className="mt-3 text-sm text-red-400">{questionBatchError}</p>}
            {questionBatch.length > 0 && (
              <div className="mt-8 space-y-3">
                <div className="flex items-center gap-3 rounded-xl border border-[#242a33] bg-[#14171c] px-4 py-3">
                  <label className="flex items-center gap-2 text-sm text-[#9aa4b2] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={pickedQuestions.size === questionBatch.length && questionBatch.length > 0}
                      onChange={e =>
                        setPickedQuestions(e.target.checked ? new Set(questionBatch.map((_, i) => i)) : new Set())
                      }
                      className="accent-[#ff4500] w-4 h-4"
                    />
                    Select all
                  </label>
                  {pickedQuestions.size > 0 && (
                    <>
                      <span className="text-sm text-[#9aa4b2]">{pickedQuestions.size} selected</span>
                      <button
                        onClick={addPickedToBoard}
                        className="ml-auto bg-[#ff4500] hover:bg-[#ff6a33] text-white text-sm font-medium px-3.5 py-1.5 rounded-lg transition-colors"
                      >
                        Add to Board
                      </button>
                    </>
                  )}
                </div>

                {questionBatch.map((item, index) => (
                  <article
                    key={`${index}-${item.question}`}
                    className={`border rounded-2xl p-5 sm:p-6 transition-colors ${
                      pickedQuestions.has(index) ? 'border-[#ff4500] bg-[#181b21] shadow-[0_0_0_1px_rgba(255,69,0,0.12)]' : 'border-[#242a33] bg-[#14171c] hover:border-[#343b47]'
                    }`}
                  >
                    <div className="flex gap-3 min-w-0">
                      <input
                        type="checkbox"
                        checked={pickedQuestions.has(index)}
                        onChange={() => toggleQuestion(index)}
                        className="accent-[#ff4500] w-4 h-4 mt-1 flex-none"
                        title="Pick this one"
                      />
                      <span className="text-xs text-[#ff6a33] font-mono pt-1">L{item.layer ?? 1}</span>
                      <div className="min-w-0">
                        <h3 className="text-base font-semibold text-[#e8eaed] break-words">{item.question}</h3>
                        {item.answer ? (
                          <>
                            <p className="mt-3 text-sm leading-relaxed text-[#9aa4b2] whitespace-pre-wrap">
                              {renderAnswer(item.answer, (item.sources ?? []) as unknown as AskSource[])}
                            </p>
                            {scottActive && item.validation && (
                              <div className="mt-3 flex flex-wrap items-center gap-2">
                                <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${item.validation.mode === 'simple' ? 'border-sky-300/30 bg-sky-300/10 text-sky-300' : item.validation.passed ? 'border-[#50c878]/30 bg-[#50c878]/10 text-[#50c878]' : 'border-amber-300/30 bg-amber-300/10 text-amber-300'}`}>
                                  {item.validation.mode === 'simple' ? 'Limited evidence' : 'Evidence score'} {item.validation.score}/100
                                </span>
                                <span className="text-xs text-[#9aa4b2]">{item.validation.verified} relevant threads · {item.validation.communities} communities{item.validation.mode === 'simple' ? ' · direct answer path' : ''}{item.validation.retried ? ' · refined once' : ''}</span>
                                {item.scoreDelta !== undefined && (
                                  <span className={`text-xs font-semibold ${item.scoreDelta > 0 ? 'text-[#50c878]' : 'text-amber-300'}`}>
                                    {item.scoreDelta > 0 ? '+' : ''}{item.scoreDelta} from previous layer
                                  </span>
                                )}
                              </div>
                            )}
                            {scottActive && item.run && (
                              <div className={`mt-3 rounded-lg border px-3 py-2.5 ${item.run.checks?.some(check => !check.passed) ? 'border-amber-300/25 bg-amber-300/5' : 'border-[#30353e] bg-[#101114]'}`}>
                                <p className={`text-xs font-medium ${item.run.checks?.some(check => !check.passed) ? 'text-amber-300' : 'text-[#50c878]'}`}>
                                  {item.run.checks?.some(check => !check.passed)
                                    ? `${item.run.checks.filter(check => !check.passed).length} failed check${item.run.checks.filter(check => !check.passed).length === 1 ? '' : 's'}`
                                    : 'All checks passed'}
                                </p>
                                {item.run.checks?.filter(check => !check.passed).map(check => (
                                  <p key={check.label} className="mt-1.5 text-xs text-[#9aa4b2]">
                                    <span className="text-[#e8eaed]">{check.label}:</span> {check.detail}
                                  </p>
                                ))}
                              </div>
                            )}
                            {!!item.sources?.length && (
                              <details className="mt-3">
                                <summary className="text-xs text-[#9aa4b2] cursor-pointer">{item.sources.length} sources</summary>
                                <ol className="mt-2 space-y-1">
                                  {item.sources.map(src => (
                                    <li key={src.n} className="text-xs">
                                      <a href={src.url} target="_blank" rel="noopener noreferrer" className="text-[#ff6a33] hover:underline">[S{src.n}] {src.title}</a>
                                      {src.site && <span className="text-[#6b7280]"> {src.site}</span>}
                                    </li>
                                  ))}
                                </ol>
                              </details>
                            )}
                            {scottActive && item.validation?.passed && (item.layer ?? 1) < 3 && (item.scoreDelta === undefined || item.scoreDelta > 0) && (
                              <button
                                onClick={() => runNextLayer(index)}
                                disabled={answeringIndex !== null}
                                className="mt-4 border border-[#ff4500] text-[#ff6a33] hover:bg-[#ff4500]/10 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-colors"
                              >
                                {answeringIndex === index ? 'Building next layer…' : 'Run next layer'}
                              </button>
                            )}
                            {scottActive && item.validation?.passed && item.scoreDelta !== undefined && item.scoreDelta <= 0 && (
                              <p className="mt-4 text-xs text-amber-300">Stopped: this layer did not improve the evidence score.</p>
                            )}
                            {scottActive && item.validation && !item.validation.passed && (
                              <p className="mt-4 text-xs text-amber-300">Stopped: this layer did not produce usable evidence.</p>
                            )}
                            {scottActive && item.run && (
                              <details className="mt-3">
                                <summary className={`text-xs cursor-pointer ${item.run.passed ? 'text-[#9aa4b2]' : 'text-amber-300'}`}>
                                  Evidence and attempts · {item.run.passed ? 'passed' : 'needs review'}
                                </summary>
                                <div className="mt-2 space-y-1 text-xs text-[#9aa4b2]">
                                  {item.run.attempts.map((attempt, attemptIndex) => (
                                    <p key={`${attempt.stage}-${attemptIndex}`}>{attempt.stage}: {attempt.passed ? 'passed' : 'failed'}{attempt.retried ? ' · refined once' : ''}</p>
                                  ))}
                                  {item.run.claims.map((claim, claimIndex) => (
                                    <p key={`${claim.text}-${claimIndex}`}>[{claim.sources.map(source => `S${source}`).join(', ')}] {claim.text}</p>
                                  ))}
                                </div>
                              </details>
                            )}
                          </>
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
            {scottActive && <aside className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto rounded-2xl border border-[#242a33] bg-[#111419] p-5 shadow-[0_20px_55px_rgba(0,0,0,0.28)]">
              <div className="flex items-center justify-between pb-4 border-b border-[#242a33]">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#747a84]">Question run</p>
                  <h3 className="mt-1 text-base font-semibold text-[#e8eaed]">How it checks itself</h3>
                </div>
                <span className={`w-2.5 h-2.5 rounded-full ${questionProgress?.running ? 'bg-[#ff4500] animate-pulse' : questionWorkflowItem?.run?.passed ? 'bg-[#50c878]' : 'bg-[#5c6470]'}`} />
              </div>
              <div className="mt-5 space-y-3">
                {questionWorkflowSteps.map((step, index) => (
                  <div key={step.number} className="relative">
                    {index < questionWorkflowSteps.length - 1 && <div className={`absolute left-[19px] top-full h-3 w-px ${step.state === 'passed' ? 'bg-[#50c878]/45' : 'bg-[#30353e]'}`} />}
                    <div className={`flex gap-3 rounded-xl border p-3 transition-all duration-300 ${step.state === 'passed' ? 'border-[#50c878]/25 bg-[#50c878]/5' : step.state === 'active' ? 'border-[#ff4500]/45 bg-[#ff4500]/8 shadow-[0_0_24px_rgba(255,69,0,0.1)]' : step.state === 'review' ? 'border-amber-300/30 bg-amber-300/5' : 'border-[#242a33] bg-[#0d0f13]'}`}>
                      <div className={`relative z-10 w-9 h-9 shrink-0 rounded-xl border flex items-center justify-center text-[10px] font-semibold ${step.state === 'passed' ? 'border-[#50c878]/40 bg-[#50c878]/10 text-[#50c878]' : step.state === 'active' ? 'border-[#ff4500]/50 bg-[#ff4500]/10 text-[#ff6a33] animate-pulse' : step.state === 'review' ? 'border-amber-300/40 bg-amber-300/10 text-amber-300' : 'border-[#30353e] bg-[#101114] text-[#747a84]'}`}>
                        {step.state === 'passed' ? '✓' : step.number}
                      </div>
                      <div className="pt-0.5 min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-[#e8eaed]">{step.title}</p>
                          <span className={`text-[9px] uppercase tracking-[0.08em] ${step.state === 'passed' ? 'text-[#50c878]' : step.state === 'active' ? 'text-[#ff6a33]' : step.state === 'review' ? 'text-amber-300' : 'text-[#5c6470]'}`}>{step.state}</span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-[#9aa4b2]">{step.detail}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </aside>}
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
                  <button
                    onClick={signInWithGoogle}
                    className="border border-[#30353e] hover:border-[#ff4500]/60 text-[#e8eaed] px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
                  >
                    Continue with Google
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
            {scottAvailable && (
              <div className="mt-4 border border-[#242a33] bg-[#14171c] rounded-xl p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-[#e8eaed]">Scott</p>
                    <p className="mt-1 text-xs text-[#9aa4b2]">Show private evidence checks and run details.</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={scottEnabled}
                    aria-label={scottEnabled ? 'Disable Scott' : 'Enable Scott'}
                    onClick={toggleScott}
                    className={`relative h-8 w-14 shrink-0 overflow-hidden rounded-full border transition-all duration-300 ${scottEnabled ? 'border-[#ff6a33] bg-[#ff4500] shadow-[inset_0_1px_4px_rgba(255,255,255,0.32),0_0_18px_rgba(255,69,0,0.24)]' : 'border-[#3a414c] bg-[#242a33] shadow-inner'}`}
                  >
                    <span className={`absolute left-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.35)] transition-transform duration-300 ease-out ${scottEnabled ? 'translate-x-6' : 'translate-x-0'}`}>
                      <span className={`h-2 w-2 rounded-full transition-colors ${scottEnabled ? 'bg-[#ff4500]' : 'bg-[#9aa4b2]'}`} />
                    </span>
                  </button>
                </div>
              </div>
            )}
            {scottAdminVisible && (
              <div className="mt-4 border border-[#242a33] bg-[#14171c] rounded-xl p-4">
                <div className="mb-4">
                  <p className="text-sm font-medium text-[#e8eaed]">Scott access</p>
                  <p className="mt-1 text-xs text-[#9aa4b2]">Choose who can use self-correction.</p>
                </div>
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={scottAdminEmail}
                    onChange={e => setScottAdminEmail(e.target.value)}
                    placeholder="user@email.com"
                    className="min-w-0 flex-1 bg-[#0b0d10] border border-[#242a33] rounded-lg px-3 py-2 text-xs text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
                  />
                  <button
                    type="button"
                    onClick={() => updateScottAccess(scottAdminEmail, true)}
                    disabled={!scottAdminEmail.trim() || Boolean(scottAdminBusy)}
                    className="bg-[#ff4500] hover:bg-[#ff6a33] text-white px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors"
                  >
                    Enable
                  </button>
                  <button
                    type="button"
                    onClick={() => inviteScottUser(scottAdminEmail)}
                    disabled={!scottAdminEmail.trim() || Boolean(scottAdminBusy)}
                    className="border border-[#ff4500] text-[#ff6a33] hover:bg-[#ff4500]/10 px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors"
                  >
                    Invite
                  </button>
                </div>
                {scottAdminError && <p className="mt-2 text-xs text-red-400">{scottAdminError}</p>}
                {scottAdminNotice && <p className="mt-2 text-xs text-green-400">{scottAdminNotice}</p>}
                <div className="mt-4 divide-y divide-[#242a33] border-t border-[#242a33]">
                  {scottAdminUsers.map(user => (
                    <div key={user.email} className="flex items-center justify-between gap-3 py-3">
                      <span className="min-w-0 truncate text-xs text-[#e8eaed]">{user.email}</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={user.enabled}
                          aria-label={`${user.enabled ? 'Disable' : 'Enable'} Scott for ${user.email}`}
                          onClick={() => updateScottAccess(user.email, !user.enabled)}
                          disabled={Boolean(scottAdminBusy)}
                          className={`relative h-8 w-14 shrink-0 overflow-hidden rounded-full border transition-all duration-300 disabled:opacity-40 ${user.enabled ? 'border-[#ff6a33] bg-[#ff4500] shadow-[inset_0_1px_4px_rgba(255,255,255,0.32),0_0_18px_rgba(255,69,0,0.24)]' : 'border-[#3a414c] bg-[#242a33] shadow-inner'}`}
                        >
                          <span className={`absolute left-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.35)] transition-transform duration-300 ease-out ${user.enabled ? 'translate-x-6' : 'translate-x-0'}`}>
                            <span className={`h-2 w-2 rounded-full transition-colors ${user.enabled ? 'bg-[#ff4500]' : 'bg-[#9aa4b2]'}`} />
                          </span>
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${user.email}`}
                          onClick={() => deleteScottUser(user.email)}
                          disabled={Boolean(scottAdminBusy)}
                          className="rounded-md border border-red-400/35 px-2 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-400/10 disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Ask Reddit answers: cited answer + sources per turn, then follow-up box */}
        {view === 'results' && searches.length > 0 && (
          <div className="mt-8 space-y-6">
            {searches.map((search, si) => (
            <div key={si} className="space-y-4">
            {si === 1 && (
              <p className="pt-4 border-t border-[#242a33] text-xs uppercase tracking-wide text-[#6b7280]">Earlier searches</p>
            )}
            {search.map((turn, ti) => (
              <div key={ti} className="border border-[#242a33] bg-[#14171c] rounded-xl p-5">
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <p className="text-xs text-[#6b7280] mb-1">{ti === 0 ? 'You asked' : 'Follow-up'}</p>
                    <p className="text-[#e8eaed] font-semibold">{turn.question}</p>
                  </div>
                  {(() => {
                    const onBoard = boardIds.has(`ask::${turn.question}::${turn.answer.slice(0, 40)}`)
                    return (
                      <button
                        onClick={() => addQuestionToBoard(turn)}
                        disabled={onBoard}
                        className="shrink-0 text-xs border border-[#242a33] rounded-md px-2.5 py-1 text-[#9aa4b2] hover:text-[#ff6a33] hover:border-[#ff4500]/50 disabled:text-[#50c878] disabled:border-[#50c878]/40"
                        title={onBoard ? 'This question is on the board' : 'Save question + answer to the board'}
                      >
                        {onBoard ? '✓ Board' : '+ Board'}
                      </button>
                    )
                  })()}
                </div>
                <p className="mt-4 text-sm text-[#e8eaed] leading-relaxed whitespace-pre-wrap">
                  {renderAnswer(turn.answer, turn.sources)}
                </p>
                <p className="mt-4 text-xs text-[#6b7280]">
                  Searched: {turn.queries_used.join(' · ')}
                </p>
                <details className="mt-3">
                  <summary className="text-xs text-[#9aa4b2] cursor-pointer hover:text-[#e8eaed]">
                    {turn.sources.length} Reddit threads
                  </summary>
                  <div className="mt-3 space-y-2">
                    {turn.sources.map(s => {
                      const item: ResultItem = {
                        text: s.title,
                        source_url: s.url,
                        reddit_score: 0,
                        subreddit: s.subreddit_name_prefixed,
                      }
                      return (
                        <div key={s.n} className="flex items-start gap-3 text-sm">
                          <span className="text-[#ff6a33] shrink-0">[{s.n}]</span>
                          <a href={s.url} target="_blank" rel="noopener noreferrer" className="flex-1 text-[#e8eaed] hover:underline">
                            {s.title} <span className="text-[#6b7280] text-xs">{s.subreddit_name_prefixed}</span>
                          </a>
                          <button
                            onClick={() => addToBoard(item, 'ask')}
                            disabled={boardIds.has(`${item.source_url}::${item.text.slice(0, 40)}`)}
                            className="text-xs text-[#9aa4b2] hover:text-[#ff6a33] disabled:text-[#50c878] shrink-0"
                          >
                            {boardIds.has(`${item.source_url}::${item.text.slice(0, 40)}`) ? '✓ Board' : '+ Board'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </details>
              </div>
            ))}
            {si === 0 && (
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={followUp}
                onChange={e => setFollowUp(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && doFollowUp()}
                placeholder="Ask a follow-up…"
                className="flex-1 min-w-0 bg-[#14171c] border border-[#242a33] rounded-xl px-4 py-3 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
              />
              <button
                onClick={doFollowUp}
                disabled={loading}
                className="bg-[#ff4500] hover:bg-[#ff6a33] text-white px-6 py-3 rounded-xl text-sm font-semibold disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {loading ? 'Thinking…' : 'Ask'}
              </button>
            </div>
            )}
            </div>
            ))}
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
                  Paste a Reddit URL + what you want to say. We fetch the post and draft a {commentPlatform === 'hn' ? 'Hacker News style' : 'Reddit style'} comment that fits.
                </p>

                <label className="block mt-4 text-xs font-medium text-[#9aa4b2]">
                  Post or article URL
                </label>
                <textarea
                  value={postUrl}
                  onChange={e => {
                    setPostUrl(e.target.value)
                    setPostFetched(false)
                    setPostPreview('')
                  }}
                  placeholder="https://www.reddit.com/r/... or https://example.com/article"
                  className="mt-1 w-full bg-[#14171c] border border-[#242a33] rounded-lg px-3 py-2 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
                />

                <div className="mt-2 flex items-center gap-3">
                  <button
                    onClick={fetchPost}
                    disabled={fetchingPost || !postUrl.trim()}
                    className="border border-[#ff4500] text-[#ff6a33] hover:bg-[#ff4500]/10 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors"
                  >
                    {fetchingPost ? 'Fetching…' : postFetched ? 'Post fetched ✓' : 'Fetch post'}
                  </button>
                  {postFetched && <span className="text-xs text-emerald-400">URL verified. Ready to draft.</span>}
                </div>
                {postFetched && postPreview && (
                  <div className="mt-2 rounded-lg border border-[#242a33] bg-[#0f1216] px-3 py-2 text-xs text-[#9aa4b2]">
                    {postPreview}{postPreview.length >= 280 ? '…' : ''}
                  </div>
                )}

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
                    disabled={commenting || !postFetched || !intent.trim()}
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
