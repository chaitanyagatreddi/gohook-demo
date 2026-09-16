import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabaseClient'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

// Colours come from the app's existing palette. Nothing new invented.
const KIND_COLOR: Record<string, string> = {
  thread: '#ff4500',
  subreddit: '#7a9bff',
  topic: '#e879f9',
  author: '#ffb020',
}
const DIM = '#6b7280'

export type GraphNode = {
  id: string
  kind: 'thread' | 'subreddit' | 'topic' | 'author'
  label: string
  permalink?: string
  how?: string[]   // 'cited' = from a question, 'saved' = from the Board, 'authored' = your own Reddit
  over_18?: boolean
  score?: number
  captured_at?: string
}

// The four ways to look at the same graph.
const VIEWS = [
  { key: 'all', label: 'Everything' },
  { key: 'cited', label: 'Searched' },
  { key: 'saved', label: 'Saved' },
  { key: 'authored', label: 'My Reddit' },
] as const
type ViewKey = typeof VIEWS[number]['key']
export type GraphEdge = { from: string; to: string; type: string }
export type GraphData = { nodes: GraphNode[]; edges: GraphEdge[] }

type Placed = GraphNode & { x: number; y: number; vx: number; vy: number; degree: number }

const KINDS = ['thread', 'subreddit', 'topic', 'author'] as const

/**
 * Spreads the nodes out: connected things pull together, everything pushes apart,
 * and a gentle pull to the middle stops the picture drifting off screen.
 * Runs on a plain canvas so there is no graph library to install.
 */
function layout(nodes: Placed[], edges: GraphEdge[], width: number, height: number) {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const cx = width / 2
  const cy = height / 2

  for (const n of nodes) {
    n.vx *= 0.92
    n.vy *= 0.92
    n.vx += (cx - n.x) * 0.0014
    n.vy += (cy - n.y) * 0.0014
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d2 = dx * dx + dy * dy || 0.01
      if (d2 > 57600) continue // far apart, ignore
      const push = 1100 / d2
      const d = Math.sqrt(d2)
      const ux = (dx / d) * push
      const uy = (dy / d) * push
      a.vx -= ux; a.vy -= uy
      b.vx += ux; b.vy += uy
    }
  }

  for (const e of edges) {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01
    const pull = (d - 125) * 0.003
    const ux = (dx / d) * pull
    const uy = (dy / d) * pull
    a.vx += ux; a.vy += uy
    b.vx -= ux; b.vy -= uy
  }

  const margin = 46
  for (const n of nodes) {
    // Near an edge, push steadily back towards the middle. A bounce alone let
    // dots settle against the wall and pile up in a line.
    if (n.x < margin) n.vx += (margin - n.x) * 0.05
    if (n.x > width - margin) n.vx -= (n.x - (width - margin)) * 0.05
    if (n.y < margin) n.vy += (margin - n.y) * 0.05
    if (n.y > height - margin) n.vy -= (n.y - (height - margin)) * 0.05

    n.x += Math.max(-1.8, Math.min(1.8, n.vx))
    n.y += Math.max(-1.8, Math.min(1.8, n.vy))

    // Hard stop, so nothing can leave the panel even while being dragged.
    n.x = Math.max(14, Math.min(width - 14, n.x))
    n.y = Math.max(14, Math.min(height - 14, n.y))
  }
}

type GraphProps = { signedIn: boolean; onSignIn: () => void }

export default function Graph({ signedIn, onSignIn }: GraphProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const placedRef = useRef<Placed[]>([])
  const dragRef = useRef<{ id: string | null; ox: number; oy: number }>({ id: null, ox: 0, oy: 0 })

  const [data, setData] = useState<GraphData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [depth, setDepth] = useState(2)
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<string[]>([...KINDS])
  const [slice, setSlice] = useState<ViewKey>('all')
  const [reddit, setReddit] = useState<{ connected: boolean; username?: string; state?: string } | null>(null)
  const [redditBusy, setRedditBusy] = useState<'connecting' | 'syncing' | null>(null)
  const [redditNote, setRedditNote] = useState('')

  async function authHeaders(): Promise<Record<string, string>> {
    const { data } = await supabase.auth.getSession()
    return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}
  }

  // Ask the backend whether this person's Reddit is connected.
  async function checkReddit() {
    try {
      const res = await fetch(`${API}/reddit/status`, { headers: await authHeaders() })
      if (!res.ok) return
      setReddit(await res.json())
    } catch { /* leave it unknown */ }
  }

  useEffect(() => { if (signedIn) checkReddit() }, [signedIn])

  // Opening the link in a new tab, then checking again when they come back.
  async function connectReddit() {
    setRedditBusy('connecting')
    setRedditNote('')
    try {
      const res = await fetch(`${API}/reddit/connect`, { method: 'POST', headers: await authHeaders() })
      if (!res.ok) throw new Error((await res.json()).detail || 'Could not start')
      const { url } = await res.json()
      window.open(url, '_blank', 'noopener')
      setRedditNote('Finish signing in on the new tab, then come back and press Check.')
    } catch (e) {
      setRedditNote(e instanceof Error ? e.message : 'Could not start connecting.')
    } finally {
      setRedditBusy(null)
    }
  }

  // Pull their own posts in, then redraw the graph.
  async function syncReddit() {
    setRedditBusy('syncing')
    setRedditNote('')
    try {
      const res = await fetch(`${API}/reddit/sync`, { method: 'POST', headers: await authHeaders() })
      const out = await res.json()
      if (!res.ok) throw new Error(out.detail || 'Could not read your posts')
      setRedditNote(out.added ? `Added ${out.added} of your posts.` : 'No posts found for your account.')
      const g = await fetch(`${API}/graph`, { headers: await authHeaders() })
      if (g.ok) setData(await g.json())
    } catch (e) {
      setRedditNote(e instanceof Error ? e.message : 'Could not read your posts.')
    } finally {
      setRedditBusy(null)
    }
  }
  const [redditHidden, setRedditHidden] = useState(() => {
    try { return localStorage.getItem('gohook_reddit_prompt_hidden') === '1' } catch { return false }
  })

  useEffect(() => {
    if (!signedIn) { setLoading(false); return }
    let cancelled = false
    ;(async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession()
        const headers: Record<string, string> = sessionData.session
          ? { Authorization: `Bearer ${sessionData.session.access_token}` }
          : {}
        const res = await fetch(`${API}/graph`, { headers })
        if (!res.ok) throw new Error(String(res.status))
        const json = (await res.json()) as GraphData
        if (!cancelled) setData(json)
      } catch {
        if (!cancelled) setError("Couldn't load your graph. Search for something first, then come back.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [signedIn])

  const visible = useMemo(() => {
    if (!data) return { nodes: [], edges: [] as GraphEdge[] }

    let nodes = data.nodes.filter(n => kinds.includes(n.kind))

    if (slice !== 'all') {
      // Keep the threads that came in this way, plus anything joined to them.
      const keep = new Set(
        nodes.filter(n => n.kind === 'thread' && (n.how || []).includes(slice)).map(n => n.id)
      )
      for (const e of data.edges) {
        if (keep.has(e.from)) keep.add(e.to)
        else if (keep.has(e.to)) keep.add(e.from)
      }
      nodes = nodes.filter(n => keep.has(n.id))
    }

    const ids = new Set(nodes.map(n => n.id))
    return { nodes, edges: data.edges.filter(e => ids.has(e.from) && ids.has(e.to)) }
  }, [data, kinds, slice])

  const degrees = useMemo(() => {
    const d = new Map<string, number>()
    for (const e of visible.edges) {
      d.set(e.from, (d.get(e.from) || 0) + 1)
      d.set(e.to, (d.get(e.to) || 0) + 1)
    }
    return d
  }, [visible])

  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const e of visible.edges) {
      if (!map.has(e.from)) map.set(e.from, new Set())
      if (!map.has(e.to)) map.set(e.to, new Set())
      map.get(e.from)!.add(e.to)
      map.get(e.to)!.add(e.from)
    }
    return map
  }, [visible])

  // Dots whose name contains what was typed.
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const hits = visible.nodes.filter(n => n.label.toLowerCase().includes(q)).map(n => n.id)
    return hits.length ? new Set(hits) : new Set<string>()
  }, [query, visible])

  // Everything within `depth` steps of the selected node.
  const reached = useMemo(() => {
    if (!selected) return null
    const seen = new Set([selected])
    let frontier = [selected]
    for (let step = 0; step < depth; step++) {
      const next: string[] = []
      for (const id of frontier) {
        for (const other of neighbours.get(id) || []) {
          if (!seen.has(other)) { seen.add(other); next.push(other) }
        }
      }
      frontier = next
    }
    return seen
  }, [selected, depth, neighbours])

  const mostConnected = useMemo(() => {
    return [...visible.nodes]
      .map(n => ({ ...n, degree: degrees.get(n.id) || 0 }))
      .sort((a, b) => b.degree - a.degree)
      .filter(n => (query ? n.label.toLowerCase().includes(query.toLowerCase()) : true))
      .slice(0, 8)
  }, [visible, degrees, query])

  // What stays bright: the selected neighbourhood if something is selected,
  // otherwise the search matches, otherwise everything.
  const lit = reached ?? matched
  const selectedNode = selected ? visible.nodes.find(n => n.id === selected) : undefined

  // A thread's topics and its community, read off its links.
  const nodeTopics = useMemo(() => {
    if (!selected) return [] as string[]
    return [...(neighbours.get(selected) || [])]
      .map(id => visible.nodes.find(n => n.id === id))
      .filter((n): n is GraphNode => !!n && n.kind === 'topic')
      .map(n => n.label)
  }, [selected, neighbours, visible])

  const nodeCommunity = useMemo(() => {
    if (!selected) return ''
    const hit = [...(neighbours.get(selected) || [])]
      .map(id => visible.nodes.find(n => n.id === id))
      .find(n => n?.kind === 'subreddit')
    return hit?.label ?? ''
  }, [selected, neighbours, visible])

  // Only the busiest few get a name on the picture, otherwise the words
  // print on top of each other and none of them can be read.
  const labelled = useMemo(() => {
    const ranked = [...visible.nodes]
      .sort((a, b) => (degrees.get(b.id) || 0) - (degrees.get(a.id) || 0))
      .slice(0, 10)
      .map(n => n.id)
    return new Set(ranked)
  }, [visible, degrees])

  // Place nodes once per data change, then keep nudging them each frame.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight

    placedRef.current = visible.nodes.map((n, i) => {
      const angle = (i / Math.max(1, visible.nodes.length)) * Math.PI * 2
      const radius = Math.min(width, height) * 0.32
      return {
        ...n,
        x: width / 2 + Math.cos(angle) * radius,
        y: height / 2 + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        degree: degrees.get(n.id) || 0,
      }
    })
  }, [visible, degrees])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let frame = 0

    function draw() {
      const canvas = canvasRef.current
      if (!canvas || !ctx) return
      const ratio = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio
        canvas.height = height * ratio
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, width, height)

      const nodes = placedRef.current
      layout(nodes, visible.edges, width, height)
      const byId = new Map(nodes.map(n => [n.id, n]))

      for (const e of visible.edges) {
        const a = byId.get(e.from)
        const b = byId.get(e.to)
        if (!a || !b) continue
        const shown = !lit || (lit.has(e.from) && lit.has(e.to))
        ctx.strokeStyle = shown
          ? (selected ? 'rgba(255,106,51,0.58)' : 'rgba(149,160,178,0.20)')
          : 'rgba(154,164,178,0.055)'
        ctx.lineWidth = shown && selected ? 1.15 : 0.65
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      // Boxes already used by a label this frame, so two never overlap.
      const taken: Array<{ x: number; y: number; w: number; h: number }> = []

      for (const n of nodes) {
        const shown = !lit || lit.has(n.id)
        const size = 2.25 + Math.min(7, n.degree * 0.68)
        ctx.globalAlpha = shown ? 1 : 0.14
        const color = shown ? KIND_COLOR[n.kind] || DIM : DIM
        if (shown && n.degree > 5) {
          ctx.beginPath()
          ctx.fillStyle = color
          ctx.globalAlpha = 0.13
          ctx.arc(n.x, n.y, size + 6, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
        }
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(n.x, n.y, size, 0, Math.PI * 2)
        ctx.fill()

        if (n.id === selected) {
          ctx.strokeStyle = '#f7f7f8'
          ctx.lineWidth = 1.25
          ctx.beginPath()
          ctx.arc(n.x, n.y, size + 4, 0, Math.PI * 2)
          ctx.stroke()
        }

        // Name the busiest few, plus whatever is selected and its direct links.
        const named = n.id === selected || labelled.has(n.id) ||
          (selected ? (neighbours.get(selected)?.has(n.id) ?? false) : false) ||
          (matched ? matched.has(n.id) : false)
        if (shown && named) {
          const text = n.label.length > 20 ? n.label.slice(0, 19) + '…' : n.label
          ctx.font = '10.5px ui-sans-serif, system-ui, sans-serif'
          const pad = 5
          const w = ctx.measureText(text).width + pad * 2
          const h = 17

          // Try to the right of the dot first, then left, then above, then below.
          const spots = [
            { x: n.x + size + 4, y: n.y - 7 },
            { x: n.x - size - 4 - w, y: n.y - 7 },
            { x: n.x - w / 2, y: n.y - size - 4 - h },
            { x: n.x - w / 2, y: n.y + size + 4 },
          ]
          const free = spots.find(sp =>
            !taken.some(t => sp.x < t.x + t.w && sp.x + w > t.x && sp.y < t.y + t.h && sp.y + h > t.y)
          )

          // If every spot is covered, leave this one unnamed rather than
          // printing one word on top of another.
          if (free) {
            taken.push({ x: free.x, y: free.y, w, h })
            ctx.globalAlpha = 0.94
            ctx.fillStyle = '#111317'
            ctx.beginPath()
            ctx.roundRect(free.x, free.y, w, h, 4)
            ctx.fill()
            ctx.strokeStyle = 'rgba(255,255,255,0.10)'
            ctx.lineWidth = 0.5
            ctx.stroke()
            ctx.globalAlpha = 1
            ctx.fillStyle = '#e5e7eb'
            ctx.fillText(text, free.x + pad, free.y + 12)
          }
        }
        ctx.globalAlpha = 1
      }

      frame = requestAnimationFrame(draw)
    }

    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [visible, lit, matched, selected, labelled, neighbours])

  function nodeAt(clientX: number, clientY: number) {
    const canvas = canvasRef.current
    if (!canvas) return null
    const box = canvas.getBoundingClientRect()
    const x = clientX - box.left
    const y = clientY - box.top
    let best: Placed | null = null
    let bestDist = 16
    for (const n of placedRef.current) {
      const d = Math.hypot(n.x - x, n.y - y)
      if (d < bestDist) { bestDist = d; best = n }
    }
    return best
  }

  // Not signed in: there is nothing to show, because a graph belongs to a person.
  if (!signedIn) {
    return (
      <main className="relative flex-1 min-w-0 h-screen max-w-full overflow-hidden flex items-center justify-center px-4 sm:px-6 bg-[#0a0b0d]">
        <svg aria-hidden="true" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid meet" className="absolute left-1/2 max-w-full -translate-x-1/2 w-[min(1100px,92vw)] h-auto opacity-60">
          <g stroke="rgba(148,163,184,0.26)" strokeWidth="1">
            <path d="M110 350L245 210L405 300L560 150L730 265L900 125" />
            <path d="M110 350L270 505L405 300L540 495L730 265L895 470" />
            <path d="M245 210L270 505M245 210L560 150M405 300L730 265M405 300L645 385M540 495L645 385M645 385L895 470M730 265L895 470" />
          </g>
          <g fill="#ff6a33">
            <circle cx="110" cy="350" r="7" /><circle cx="405" cy="300" r="8" /><circle cx="730" cy="265" r="7" />
          </g>
          <g fill="#8fa4ff">
            <circle cx="245" cy="210" r="5" /><circle cx="560" cy="150" r="6" /><circle cx="270" cy="505" r="5" /><circle cx="895" cy="470" r="5" />
          </g>
          <g fill="#e879f9">
            <circle cx="900" cy="125" r="5" /><circle cx="540" cy="495" r="6" /><circle cx="645" cy="385" r="5" />
          </g>
        </svg>
        <div className="relative max-w-md text-center rounded-2xl border border-white/[0.07] bg-[#111216]/80 px-8 py-7 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur-sm">
          <div className="mx-auto mb-5 w-12 h-12 rounded-xl bg-[#17191e] border border-[#2a2d33] grid place-items-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="#ff6a33" strokeWidth="1.6" className="w-6 h-6">
              <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="7" r="2.5" /><circle cx="12" cy="17" r="2.5" />
              <path d="M8 7.5l8 -0.5M7.2 8.2L11 14.8M16.8 9.2L13 14.8" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold">Your graph is yours alone</h2>
          <p className="text-sm text-[#9aa4b2] mt-2 leading-relaxed">
            Sign in and every question you ask starts building it — the threads you read,
            the communities they come from, and what they are all about.
          </p>
          <button
            onClick={onSignIn}
            className="mt-6 bg-[#ff4500] hover:bg-[#ff6a33] text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
          >
            Sign in
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="flex-1 min-w-0 min-h-screen lg:h-screen lg:overflow-hidden flex flex-col bg-[#0a0b0d]">
      <header className="px-4 sm:px-6 pt-5 sm:pt-6 pb-4 flex items-center gap-3 flex-wrap border-b border-[#1d2025]">
        <h2 className="text-lg font-semibold tracking-[-0.02em]">Your graph</h2>
        <span className="text-xs text-[#7f858e]">Threads, communities and topics you've searched or saved.</span>

        <div className="ml-auto flex items-center gap-1 rounded-lg bg-[#141518] border border-[#292c32] p-1 shadow-[0_8px_30px_rgba(0,0,0,0.15)]">
          {VIEWS.map(v => (
            <button
              key={v.key}
              onClick={() => { setSlice(v.key); setSelected(null) }}
              disabled={v.key === 'authored' && !reddit?.connected && !data?.nodes.some(n => (n.how || []).includes('authored'))}
              title={v.key === 'authored' ? 'Needs your Reddit account connected' : undefined}
              className={`text-xs px-2.5 py-1.5 rounded-md transition-colors ${
                slice === v.key
                  ? 'bg-[#24272d] text-[#f4f5f6] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
                  : 'text-[#858b95] hover:text-[#e8eaed] hover:bg-[#1d2025] disabled:text-[#3a4250] disabled:hover:bg-transparent disabled:cursor-not-allowed'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </header>

      {/* Reddit account. Hidden once connected and pulled in, unless something went wrong. */}
      {!redditHidden && (
        <div className="mx-4 sm:mx-6 mb-3 rounded-xl bg-[#121417] border border-[#272a30] px-4 py-3 flex items-center gap-3 flex-wrap shadow-[0_12px_30px_rgba(0,0,0,0.12)]">
          <span className={`w-2 h-2 rounded-full flex-none ${reddit?.connected ? 'bg-[#50c878]' : 'bg-[#ff4500]'}`} />

          <p className="text-sm flex-1 min-w-[240px]">
            {reddit?.connected
              ? <>Connected as <span className="font-medium">u/{reddit.username ?? '…'}</span>. Pull your posts in to see them on the graph.</>
              : 'Connect your Reddit account to add your own posts to the graph.'}
            {redditNote && <span className="block text-xs text-[#9aa4b2] mt-1">{redditNote}</span>}
          </p>

          {reddit?.connected ? (
            <button
              onClick={syncReddit}
              disabled={redditBusy !== null}
              className="text-sm font-medium px-3 py-1.5 rounded-lg bg-[#ff4500] hover:bg-[#ff6a33] text-white disabled:opacity-50 transition-colors"
            >
              {redditBusy === 'syncing' ? 'Reading your posts…' : 'Pull my posts in'}
            </button>
          ) : (
            <>
              <button
                onClick={connectReddit}
                disabled={redditBusy !== null}
                className="text-sm font-medium px-3 py-1.5 rounded-lg bg-[#ff4500] hover:bg-[#ff6a33] text-white disabled:opacity-50 transition-colors"
              >
                {redditBusy === 'connecting' ? 'Opening…' : 'Connect Reddit'}
              </button>
              {redditNote && (
                <button
                  onClick={checkReddit}
                  className="text-sm font-medium px-3 py-1.5 rounded-lg border border-[#242a33] text-[#e8eaed] hover:bg-[#242a33] transition-colors"
                >
                  Check
                </button>
              )}
            </>
          )}

          <button
            onClick={() => {
              setRedditHidden(true)
              try { localStorage.setItem('gohook_reddit_prompt_hidden', '1') } catch { /* blocked */ }
            }}
            className="text-[#9aa4b2] hover:text-[#e8eaed] text-sm px-1"
            title="Hide this"
          >
            ×
          </button>
        </div>
      )}

      {/* Counts across the top. */}
      <div className="px-4 sm:px-6 pt-2 grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Threads', value: visible.nodes.filter(n => n.kind === 'thread').length },
          { label: 'Communities', value: visible.nodes.filter(n => n.kind === 'subreddit').length },
          { label: 'Topics', value: visible.nodes.filter(n => n.kind === 'topic').length },
          { label: 'Links', value: visible.edges.length },
        ].map(card => (
          <div key={card.label} className="rounded-xl bg-[#121417] border border-[#272a30] px-4 py-3.5 shadow-[0_12px_30px_rgba(0,0,0,0.1)]">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#747a84]">{card.label}</div>
            <div className="text-3xl font-semibold tracking-[-0.03em] tabular-nums mt-1">{card.value}</div>
          </div>
        ))}
      </div>

      <div className="flex-1 min-h-0 min-w-0 px-4 sm:px-6 py-4 flex flex-col lg:flex-row gap-4">
        {/* The picture. */}
        <div className="flex-1 min-w-0 rounded-xl border border-[#2a2d33] relative overflow-hidden bg-[radial-gradient(circle_at_50%_45%,rgba(255,106,51,0.06),transparent_38%),linear-gradient(rgba(255,255,255,0.018)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.018)_1px,transparent_1px),#101114] bg-[size:auto,28px_28px,28px_28px,auto] shadow-[0_20px_50px_rgba(0,0,0,0.2)]">
          {loading && <p className="absolute inset-0 grid place-items-center text-sm text-[#9aa4b2]">Loading your graph…</p>}
          {!loading && error && <p className="absolute inset-0 grid place-items-center text-sm text-[#9aa4b2] px-8 text-center">{error}</p>}
          {!loading && !error && visible.nodes.length === 0 && (
            <p className="absolute inset-0 grid place-items-center text-sm text-[#9aa4b2] px-8 text-center">
              Nothing here yet. Ask a question or save a thread and it'll show up.
            </p>
          )}
          <canvas
            ref={canvasRef}
            className="w-full h-full block cursor-grab active:cursor-grabbing"
            onMouseDown={e => {
              const hit = nodeAt(e.clientX, e.clientY)
              if (hit) {
                dragRef.current = { id: hit.id, ox: 0, oy: 0 }
                setSelected(hit.id)
              } else {
                setSelected(null)
              }
            }}
            onMouseMove={e => {
              const id = dragRef.current.id
              if (!id) return
              const canvas = canvasRef.current
              if (!canvas) return
              const box = canvas.getBoundingClientRect()
              const node = placedRef.current.find(n => n.id === id)
              if (node) {
                node.x = Math.max(24, Math.min(box.width - 24, e.clientX - box.left))
                node.y = Math.max(24, Math.min(box.height - 24, e.clientY - box.top))
                node.vx = 0
                node.vy = 0
              }
            }}
            onMouseUp={() => { dragRef.current.id = null }}
            onMouseLeave={() => { dragRef.current.id = null }}
          />
          <div className="absolute top-4 left-4 w-[min(360px,calc(100%-2rem))]">
            <div className="flex items-center gap-2 rounded-xl bg-[#111316]/95 border border-[#30333a] px-3.5 py-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.28)] backdrop-blur">
              <svg viewBox="0 0 24 24" fill="none" stroke="#858b95" strokeWidth="1.7" className="w-4 h-4 flex-none">
                <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
              </svg>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Find anything in your graph"
                className="flex-1 bg-transparent text-sm placeholder:text-[#6b7280] focus:outline-none"
              />
              {query && (
                <>
                  <span className="text-xs text-[#9aa4b2] tabular-nums">
                    {matched ? matched.size : 0}
                  </span>
                  <button
                    onClick={() => setQuery('')}
                    className="text-[#9aa4b2] hover:text-[#e8eaed] text-sm px-1"
                    title="Clear"
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          </div>
          <span className="absolute bottom-4 right-4 text-[11px] uppercase tracking-[0.08em] text-[#747a84]">Drag to explore</span>
        </div>

        {/* Details on the right. */}
        <aside className="hidden lg:flex w-[320px] flex-none flex-col gap-3 overflow-y-auto">
          {!selectedNode ? (
            <>
              <div className="flex flex-wrap gap-2">
                {KINDS.map(k => {
                  const on = kinds.includes(k)
                  return (
                    <button
                      key={k}
                      onClick={() => setKinds(prev => (on ? prev.filter(x => x !== k) : [...prev, k]))}
                      className={`text-xs px-2.5 py-1.5 rounded-md border transition-colors ${on ? 'border-[#343840] bg-[#181a1f] text-[#e8eaed]' : 'border-[#24272d] bg-[#101114] text-[#747a84] hover:text-[#c4c8cf]'}`}
                    >
                      <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: on ? KIND_COLOR[k] : DIM }} />
                      {k}
                    </button>
                  )
                })}
              </div>

              <div className="rounded-xl bg-[#121417] border border-[#2a2d33] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.12)]">
                <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#858b95] mb-2">Most connected</h3>
                {mostConnected.length === 0 ? (
                  <p className="text-xs text-[#6b7280]">Nothing to show yet.</p>
                ) : (
                  <ul className="flex flex-col">
                    {mostConnected.map(n => (
                      <li key={n.id}>
                        <button
                          onClick={() => setSelected(n.id)}
                          className="w-full flex items-center gap-2 py-2 text-left hover:bg-[#1d2025] rounded-md px-1.5 transition-colors"
                        >
                          <span className="w-2 h-2 rounded-sm flex-none" style={{ background: KIND_COLOR[n.kind] }} />
                          <span className="text-sm truncate flex-1">{n.label}</span>
                          {n.over_18 && (
                            <span className="text-[10px] font-medium px-1 rounded bg-[#ff4500]/15 text-[#ff6a33] flex-none">18+</span>
                          )}
                          <span className="text-xs text-[#9aa4b2] flex-none">{n.kind} {n.degree}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="rounded-xl bg-[#121417] border border-[#2a2d33] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.12)]">
                <div className="flex items-start gap-2">
                  <button onClick={() => setSelected(null)} className="text-[#858b95] hover:text-[#e8eaed] text-sm">←</button>
                  <span className="w-2 h-2 rounded-sm mt-1.5 flex-none" style={{ background: KIND_COLOR[selectedNode.kind] }} />
                  <h3 className="text-sm font-medium flex-1 break-words">{selectedNode.label}</h3>
                </div>
                <dl className="mt-4 border-t border-[#25282e] pt-3 text-xs flex flex-col gap-2.5">
                  <div className="flex justify-between gap-3">
                    <dt className="text-[#9aa4b2]">kind</dt>
                    <dd className="flex items-center gap-2">
                      {selectedNode.kind}
                      {selectedNode.over_18 && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#ff4500]/15 text-[#ff6a33]">
                          18+
                        </span>
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-[#9aa4b2]">links</dt>
                    <dd>{degrees.get(selectedNode.id) || 0}</dd>
                  </div>
                  {typeof selectedNode.score === 'number' && selectedNode.score > 0 && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-[#9aa4b2]">upvotes</dt>
                      <dd>{selectedNode.score}</dd>
                    </div>
                  )}
                  {nodeTopics.length > 0 && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-[#9aa4b2]">topics</dt>
                      <dd className="text-right">{nodeTopics.join(', ')}</dd>
                    </div>
                  )}
                  {nodeCommunity && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-[#9aa4b2]">community</dt>
                      <dd>{nodeCommunity}</dd>
                    </div>
                  )}
                  {selectedNode.how && selectedNode.how.length > 0 && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-[#9aa4b2]">came from</dt>
                      <dd className="text-right">
                        {selectedNode.how
                          .map(h => (h === 'cited' ? 'a question' : h === 'saved' ? 'your Board' : 'your Reddit'))
                          .join(', ')}
                      </dd>
                    </div>
                  )}
                  {selectedNode.captured_at && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-[#9aa4b2]">seen</dt>
                      <dd>{new Date(selectedNode.captured_at).toLocaleDateString()}</dd>
                    </div>
                  )}
                  {selectedNode.permalink && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-[#9aa4b2]">thread</dt>
                      <dd>
                        <a
                          href={selectedNode.permalink.startsWith('http') ? selectedNode.permalink : `https://reddit.com${selectedNode.permalink}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#ff6a33] underline"
                        >
                          open on Reddit
                        </a>
                      </dd>
                    </div>
                  )}
                </dl>
              </div>

              <div className="rounded-xl bg-[#121417] border border-[#2a2d33] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.12)]">
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#858b95]">What it touches</h3>
                  <div className="flex gap-1 rounded-md border border-[#292c32] bg-[#0d0f12] p-0.5">
                    {[1, 2, 3].map(d => (
                      <button
                        key={d}
                        onClick={() => setDepth(d)}
                        className={`w-7 h-7 text-xs rounded ${depth === d ? 'bg-[#25282e] text-white' : 'text-[#858b95] hover:bg-[#1d2025]'}`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-[#9aa4b2] mt-2">
                  {(reached ? reached.size - 1 : 0)} things within {depth} step{depth > 1 ? 's' : ''}.
                </p>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {[...(neighbours.get(selectedNode.id) || [])].slice(0, 24).map(id => {
                    const n = visible.nodes.find(x => x.id === id)
                    if (!n) return null
                    return (
                      <button
                        key={id}
                        onClick={() => setSelected(id)}
                        className="text-xs px-2 py-1 rounded-md bg-[#17191e] border border-[#292c32] hover:border-[#51555d] truncate max-w-[140px] transition-colors"
                        title={n.label}
                      >
                        {n.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
    </main>
  )
}
