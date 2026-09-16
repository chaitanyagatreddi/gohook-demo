import { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { authHeaders } from './supabaseClient'

type Part = { key: string; label: string; score: number; out_of: number; detail: string }
type Thread = { title: string; url: string; subreddit: string; competitors_here?: string[] }
type Report = {
  brand: string
  category: string
  score: number
  parts: Part[]
  missing_communities: string[]
  earned: Thread[]
  self_posted: number
  opportunities: Thread[]
  competitors: Record<string, number>
}

const EASE = [0.22, 0.61, 0.36, 1] as const

const verdict = (score: number) =>
  score >= 70 ? 'You show up where it counts'
  : score >= 40 ? 'You are on Reddit, but not where they are asking'
  : 'Reddit does not know you yet'

/** The Reddit Presence Score: what a brand has, what it is missing, what to do next. */
export default function Audit({ api }: { api: string }) {
  const [brand, setBrand] = useState('')
  const [category, setCategory] = useState('')
  const [competitors, setCompetitors] = useState('')
  const [report, setReport] = useState<Report | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function run() {
    setError(''); setBusy(true); setReport(null)
    try {
      const res = await fetch(`${api}/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({
          brand,
          category,
          competitors: competitors.split(',').map(c => c.trim()).filter(Boolean),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not finish the audit.')
      setReport(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not finish the audit.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="border-b border-[#242a33] pb-6 mb-6">
        <h2 className="text-3xl font-bold tracking-tight">Reddit Presence Score</h2>
        <p className="text-sm text-[#9aa4b2] mt-2">
          Where your buyers are asking, where your competitors already answer, and where you are missing.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-[#9aa4b2]">
          Your brand
          <input
            value={brand}
            onChange={e => setBrand(e.target.value)}
            placeholder="Attio"
            className="mt-1 w-full rounded-lg border border-[#242a33] bg-[#14171c] px-3 py-2 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
          />
        </label>
        <label className="text-xs text-[#9aa4b2]">
          What you sell
          <input
            value={category}
            onChange={e => setCategory(e.target.value)}
            placeholder="CRM for startups"
            className="mt-1 w-full rounded-lg border border-[#242a33] bg-[#14171c] px-3 py-2 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
          />
        </label>
        <label className="text-xs text-[#9aa4b2]">
          Competitors <span className="text-[#6b7280]">(comma separated)</span>
          <input
            value={competitors}
            onChange={e => setCompetitors(e.target.value)}
            placeholder="Folk, HubSpot"
            className="mt-1 w-full rounded-lg border border-[#242a33] bg-[#14171c] px-3 py-2 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={run}
          disabled={busy || !brand.trim()}
          className="rounded-lg bg-[#ff4500] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#ff6a33] disabled:opacity-40"
        >
          {busy ? 'Checking Reddit…' : 'Get my score →'}
        </button>
        <span className="text-xs text-[#6b7280]">Uses your connected Reddit account to check what you can post today.</span>
      </div>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      <AnimatePresence>
        {busy && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-6 space-y-2">
            {[0, 1, 2].map(i => (
              <motion.div
                key={i}
                className="h-4 rounded bg-[#1a1d23]"
                style={{ width: `${80 - i * 20}%` }}
                animate={{ opacity: [0.35, 0.8, 0.35] }}
                transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.15 }}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {report && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: EASE }}
          className="mt-8 space-y-4"
        >
          <div className="rounded-2xl border border-[#242a33] bg-[#14171c] p-6">
            <p className="text-[11px] uppercase tracking-[0.1em] text-[#858b95]">{report.brand}</p>
            <div className="mt-2 flex items-end gap-3">
              <motion.span
                className="text-5xl font-bold tabular-nums text-[#e8eaed]"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.1, duration: 0.35, ease: EASE }}
              >
                {report.score}
              </motion.span>
              <span className="pb-1.5 text-sm text-[#6b7280]">of 100</span>
            </div>
            <p className="mt-2 text-sm text-[#e8eaed]">{verdict(report.score)}</p>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-[#242a33]">
              <motion.div
                className={`h-full rounded-full ${report.score >= 70 ? 'bg-[#50c878]' : report.score >= 40 ? 'bg-amber-300' : 'bg-[#ff4500]'}`}
                initial={{ width: 0 }}
                animate={{ width: `${report.score}%` }}
                transition={{ delay: 0.15, duration: 0.6, ease: EASE }}
              />
            </div>
          </div>

          <div className="rounded-xl border border-[#242a33] bg-[#14171c] p-4">
            <p className="text-[11px] uppercase tracking-[0.08em] text-[#858b95]">What makes up the score</p>
            <div className="mt-3 space-y-3">
              {report.parts.map((part, i) => (
                <motion.div
                  key={part.key}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.06 * i, duration: 0.25, ease: EASE }}
                >
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-[#e8eaed]">{part.label}</span>
                    <span className="tabular-nums text-[#9aa4b2]">{part.score}<span className="text-[#6b7280]">/{part.out_of}</span></span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#242a33]">
                    <div
                      className={`h-full rounded-full ${part.score / part.out_of >= 0.7 ? 'bg-[#50c878]' : part.score ? 'bg-amber-300' : 'bg-[#3a4250]'}`}
                      style={{ width: `${(part.score / part.out_of) * 100}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-[#9aa4b2]">{part.detail}</p>
                </motion.div>
              ))}
            </div>
          </div>

          {report.missing_communities.length > 0 && (
            <div className="rounded-xl border border-[#242a33] bg-[#14171c] p-4">
              <p className="text-[11px] uppercase tracking-[0.08em] text-[#858b95]">Coverage gap</p>
              <p className="mt-1 text-sm text-[#e8eaed]">These communities discuss {report.category}. You are not in them.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {report.missing_communities.map(sub => (
                  <a
                    key={sub}
                    href={`https://reddit.com/${sub}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-full border border-[#30353e] bg-[#0b0d10] px-3 py-1 text-xs text-[#d7dbe1] hover:border-[#ff4500]/50"
                  >
                    {sub} ↗
                  </a>
                ))}
              </div>
            </div>
          )}

          {report.opportunities.length > 0 && (
            <div className="rounded-xl border border-[#ff4500]/25 bg-[#ff4500]/5 p-4">
              <p className="text-[11px] uppercase tracking-[0.08em] text-[#ff6a33]">Threads you are missing</p>
              <p className="mt-1 text-sm text-[#e8eaed]">People choosing what to buy, without you in the conversation.</p>
              <ul className="mt-3 space-y-2">
                {report.opportunities.map(thread => (
                  <li key={thread.url}>
                    <a href={thread.url} target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-[#242a33] bg-[#0d0f13] p-2.5 hover:border-[#ff4500]/40">
                      <p className="text-xs text-[#e8eaed]">{thread.title}</p>
                      <p className="mt-1 text-[11px] text-[#9aa4b2]">
                        {thread.subreddit || 'Reddit'}
                        {thread.competitors_here?.length ? ` · ${thread.competitors_here.join(', ')} answered here` : ''}
                      </p>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.earned.length > 0 && (
            <div className="rounded-xl border border-[#242a33] bg-[#14171c] p-4">
              <p className="text-[11px] uppercase tracking-[0.08em] text-[#858b95]">People already talking about you</p>
              <ul className="mt-3 space-y-2">
                {report.earned.map(thread => (
                  <li key={thread.url}>
                    <a href={thread.url} target="_blank" rel="noopener noreferrer" className="text-xs text-[#d7dbe1] hover:text-[#ff6a33]">
                      {thread.title} <span className="text-[#6b7280]">· {thread.subreddit}</span>
                    </a>
                  </li>
                ))}
              </ul>
              {report.self_posted > 0 && (
                <p className="mt-3 text-xs text-[#6b7280]">{report.self_posted} more were posted by you, so they do not count towards the score.</p>
              )}
            </div>
          )}
        </motion.div>
      )}
    </div>
  )
}
