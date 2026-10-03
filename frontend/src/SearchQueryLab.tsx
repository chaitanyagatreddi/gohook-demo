import { Fragment, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { authHeaders } from './supabaseClient'

type Site = { url: string; permission: string }
type TopOpportunity = { query: string; impressions: number; position: number; est_extra_clicks: number }
type Group = {
  group: string
  rows: number
  clicks: number
  impressions: number
  ctr: number | null
  avg_position: number | null
  striking_distance: number
  page_2: number
  est_extra_clicks: number
  top_opportunities: TopOpportunity[]
  pattern: string
  filter_type: string
  finds: string
}
type Opportunity = {
  rank: number
  query: string
  page: string
  position: number
  clicks: number
  impressions: number
  est_extra_clicks: number | null
  low_data: boolean
  action: string
  groups: string[]
}
type RunView = {
  run: { id: string; site_url: string; start_date: string; end_date: string; brand_name: string; brand_regex: string; created_at: string; row_count: number }
  from_csv: boolean
  week: { week: number; of: number; visible_rows: number; row_count: number }
  groups: Group[]
  opportunities: Opportunity[]
}
type Connection = 'checking' | 'not_connected' | 'ok' | 'needs_reconnect'

/** The brand pattern, shown while typing. The server builds the real one with RE2; this follows the same rule. */
export function brandPattern(name: string): string {
  const words = name.trim().replace(/([a-z0-9])(?=[A-Z])/g, '$1 ').toLowerCase().split(/[\s\-_.]+/).filter(Boolean)
  if (!words.length) return ''
  const escape = (w: string) => w.replace(/[^A-Za-z0-9_\u0080-￿]/g, c => '\\' + c)
  return '(?i)' + words.map(escape).join(' ?')
}

const HOW_TO = 'In Search Console: Performance → Search results → + Add filter → Query → Custom (regex). Paste the pattern, then choose the filter type shown.'
const siteLabel = (url: string) => url.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/$/, '')
const pct = (v: number | null) => (v === null ? '–' : `${(v * 100).toFixed(2)}%`)
const num = (v: number) => Math.round(v).toLocaleString('en-US')
const one = (v: number | null) => (v === null ? '–' : v.toFixed(1))

function OrangeButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      initial="rest"
      animate="rest"
      whileHover="hover"
      whileTap="tap"
      variants={{
        rest: { y: 0, scale: 1, backgroundColor: '#ff4500' },
        hover: { y: -2, backgroundColor: '#ff6a2b' },
        tap: { scale: 0.97, backgroundColor: '#cc3700' },
      }}
      transition={{ type: 'spring', bounce: 0.28, duration: 0.42 }}
      className="inline-flex items-center gap-2 rounded-lg px-[18px] py-[10px] text-sm leading-[18px] font-medium text-white disabled:opacity-40"
    >
      {children}
      <motion.span aria-hidden="true" variants={{ rest: { x: 0 }, hover: { x: 4 } }} transition={{ type: 'spring', bounce: 0.28, duration: 0.42 }}>→</motion.span>
    </motion.button>
  )
}

function RegexStrip({ entries }: { entries: { name: string; pattern: string; filter_type: string; finds: string }[] }) {
  const [copied, setCopied] = useState('')
  async function copy(name: string, pattern: string) {
    try { await navigator.clipboard.writeText(pattern); setCopied(name); setTimeout(() => setCopied(''), 2000) } catch { /* clipboard blocked */ }
  }
  return (
    <div className="space-y-4 py-3">
      {entries.map(e => (
        <div key={e.name}>
          <p className="text-base text-[#e8eaed]">{e.name}: <span className="text-[#9aa4b2]">{e.finds}</span></p>
          <div className="mt-2 flex flex-wrap items-start gap-3">
            <code className="block max-w-full break-all rounded-lg border border-[#242a33] bg-[#0b0d10] px-3 py-2 text-sm text-[#e8eaed]">{e.pattern}</code>
            <span className="rounded border border-[#30353e] px-2 py-1 text-sm text-[#c4c8cf]">{e.filter_type}</span>
            <button
              type="button"
              onClick={() => copy(e.name, e.pattern)}
              className="rounded-lg border border-[#30353e] px-3 py-1.5 text-sm font-medium text-[#e8eaed] transition-colors hover:border-[#ff4500]/60 hover:text-[#ff6a33]"
            >
              {copied === e.name ? 'Copied ✓' : 'Copy regex for GSC'}
            </button>
          </div>
        </div>
      ))}
      <p className="text-sm text-[#9aa4b2]">{HOW_TO}</p>
    </div>
  )
}

/** Search Query Lab: connect, pick a site, name the brand, run once, read the grouped and scored results. */
export default function SearchQueryLab({ api, signedIn }: { api: string; signedIn: boolean }) {
  const [connection, setConnection] = useState<Connection>('checking')
  const [sites, setSites] = useState<Site[]>([])
  const [site, setSite] = useState('')
  const [brand, setBrand] = useState('')
  const [view, setView] = useState<RunView | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState('')
  const [showAll, setShowAll] = useState(false)
  const pattern = brandPattern(brand)

  async function loadRun(id: string) {
    const res = await fetch(`${api}/gsc/run/${id}`, { headers: await authHeaders() })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || 'Could not load that run.')
    setView(data)
  }

  useEffect(() => {
    if (!signedIn) { setLoading(false); return }
    let live = true
    ;(async () => {
      try {
        const statusRes = await fetch(`${api}/gsc/status`, { headers: await authHeaders() })
        const status = await statusRes.json()
        if (!live) return
        const state: Connection = status.state === 'ok' ? 'ok' : status.state === 'needs_reconnect' ? 'needs_reconnect' : 'not_connected'
        setConnection(state)
        if (state === 'ok') {
          const sitesRes = await fetch(`${api}/gsc/sites`, { headers: await authHeaders() })
          const sitesData = await sitesRes.json()
          if (!live) return
          if (sitesRes.ok) { setSites(sitesData.sites || []); if (sitesData.sites?.length === 1) setSite(sitesData.sites[0].url) }
          else if (sitesRes.status === 409) { setConnection('needs_reconnect'); setError(sitesData.detail || '') }
        }
        const runsRes = await fetch(`${api}/gsc/runs`, { headers: await authHeaders() })
        const runs = await runsRes.json()
        if (live && runsRes.ok && runs.runs?.length) await loadRun(runs.runs[0].id)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'Could not load Search Query Lab.')
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [api, signedIn])

  async function connect() {
    setError('')
    try {
      const res = await fetch(`${api}/gsc/connect`, { method: 'POST', headers: await authHeaders() })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not start connecting Search Console.')
      try { sessionStorage.setItem('gohook_gsc_return', 'search') } catch { /* storage blocked: lands on Settings */ }
      window.location.href = data.url
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start connecting Search Console.')
    }
  }

  async function run() {
    setRunning(true); setError(''); setOpen(''); setShowAll(false)
    try {
      const res = await fetch(`${api}/gsc/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ site_url: site, brand_name: brand }),
      })
      const data = await res.json()
      if (res.status === 409) setConnection('needs_reconnect')
      if (!res.ok) throw new Error(data.detail || 'Could not run the analysis.')
      await loadRun(data.run_id)
      setShowSetup(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not run the analysis.')
    } finally {
      setRunning(false)
    }
  }

  async function runFromFile(file: File | undefined) {
    if (!file) return
    if (!brand.trim()) { setError('Type your brand name first.'); return }
    setRunning(true); setError(''); setOpen(''); setShowAll(false)
    try {
      const res = await fetch(`${api}/gsc/run-from-csv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ content: await file.text(), brand_name: brand }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not read that file.')
      await loadRun(data.run_id)
      setShowSetup(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file.')
    } finally {
      setRunning(false)
    }
  }

  if (!signedIn) {
    return (
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-8 pt-10 pb-16">
        <h2 className="text-3xl font-bold tracking-tight">Search Query Lab</h2>
        <p className="mt-3 text-base text-[#9aa4b2]">Sign in to use the Search Query Lab.</p>
      </div>
    )
  }

  const setupVisible = showSetup || (!view && !loading)
  const groups = view?.groups ?? []
  const byName = Object.fromEntries(groups.map(g => [g.group, g]))
  // Wireframe: Brand and Non-brand share one table row.
  const tableRows: { key: string; label: string; items: Group[] }[] = [
    { key: 'Questions', label: 'Questions', items: [byName['Questions']] },
    { key: 'Buying intent', label: 'Buying intent', items: [byName['Buying intent']] },
    { key: 'Comparisons', label: 'Comparisons', items: [byName['Comparisons & alternatives']] },
    { key: 'Brand', label: 'Brand / Non-brand', items: [byName['Brand'], byName['Non-brand']] },
    { key: 'Long tail', label: 'Long tail (5+ words)', items: [byName['Long tail (5+ words)']] },
    { key: 'AI', label: 'AI-style prompts (10+ words)', items: [byName['AI-style prompts (10+ words)']] },
  ].filter(r => r.items.every(Boolean))
  const pair = (items: Group[], f: (g: Group) => string) => items.map(f).join(' / ')

  const opportunities = view?.opportunities ?? []
  const shownOpportunities = showAll ? opportunities : opportunities.slice(0, 25)
  const th = 'px-3 py-2 text-left text-sm font-semibold text-[#c4c8cf] whitespace-nowrap'
  const td = 'px-3 py-3 text-base text-[#e8eaed] align-top'

  return (
    <div className="w-full max-w-6xl mx-auto px-4 sm:px-8 pt-10 pb-16">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#242a33] pb-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Search Query Lab</h2>
          <p className="mt-2 text-base text-[#9aa4b2]">Your own search data, grouped and scored. GoHook only reads your Search Console data.</p>
        </div>
        {view && !showSetup && (
          <button type="button" onClick={() => setShowSetup(true)} className="rounded-lg border border-[#30353e] px-4 py-2 text-sm font-medium text-[#e8eaed] transition-colors hover:border-[#ff4500]/60">
            New run
          </button>
        )}
      </div>

      {error && <p role="alert" className="mt-4 text-base text-red-400">{error}</p>}
      {loading && <p className="mt-6 text-base text-[#9aa4b2]">Loading…</p>}

      {setupVisible && (
        <div className="mt-6 space-y-4">
          <h3 className="text-xl font-semibold">Set up your run</h3>

          <section className="rounded-xl border border-[#242a33] bg-[#14171c] p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-base font-semibold">1. Google Search Console</h4>
              <span className={`rounded px-2 py-0.5 text-sm ${connection === 'ok' ? 'bg-green-500/10 text-green-400' : connection === 'needs_reconnect' ? 'bg-amber-500/10 text-amber-400' : 'bg-[#242a33] text-[#9aa4b2]'}`}>
                {connection === 'ok' ? '✓ Connected' : connection === 'needs_reconnect' ? 'Needs reconnect' : connection === 'checking' ? 'Checking…' : 'Not connected'}
              </span>
            </div>
            {connection !== 'ok' && connection !== 'checking' && (
              <div className="mt-3"><OrangeButton onClick={connect}>{connection === 'needs_reconnect' ? 'Reconnect' : 'Search Console'}</OrangeButton></div>
            )}
          </section>

          <section className="rounded-xl border border-[#242a33] bg-[#14171c] p-5">
            <h4 className="text-base font-semibold">2. Pick a site</h4>
            {connection !== 'ok' ? (
              <p className="mt-2 text-base text-[#9aa4b2]">Connect Search Console first.</p>
            ) : sites.length === 0 ? (
              <p className="mt-2 text-base text-[#9aa4b2]">No sites found on this Google account.</p>
            ) : (
              <fieldset className="mt-3 space-y-2">
                <legend className="sr-only">Sites on your Google account</legend>
                {sites.map(s => (
                  <label key={s.url} className="flex cursor-pointer items-center gap-3 text-base text-[#e8eaed]">
                    <input type="radio" name="gsc-site" checked={site === s.url} onChange={() => setSite(s.url)} className="h-4 w-4 accent-[#ff4500]" />
                    <span>{s.url} <span className="text-sm text-[#6b7280]">· {s.permission}</span></span>
                  </label>
                ))}
              </fieldset>
            )}
          </section>

          <section className="rounded-xl border border-[#242a33] bg-[#14171c] p-5">
            <h4 className="text-base font-semibold">3. Your brand name <span className="text-sm font-normal text-[#9aa4b2]">(so we can split brand and non-brand searches)</span></h4>
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <label className="sr-only" htmlFor="brand-name">Brand name</label>
              <input
                id="brand-name"
                type="text"
                value={brand}
                onChange={e => setBrand(e.target.value)}
                placeholder="Legacy Leap"
                className="w-64 rounded-lg border border-dashed border-[#3a4250] bg-[#0b0d10] px-3 py-2 text-base text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
              />
              <p className="text-base text-[#9aa4b2]">Pattern we will use: <code className="font-semibold text-[#e8eaed]">{pattern || '–'}</code></p>
            </div>
          </section>

          <div className="flex flex-wrap items-center gap-4">
            <OrangeButton onClick={run} disabled={running || connection !== 'ok' || !site || !pattern}>
              {running ? 'Running…' : 'Run: top 100 query + page rows, last 3 months'}
            </OrangeButton>
            <label className="cursor-pointer text-sm text-[#9aa4b2] underline hover:text-[#ff6a33]">
              Or try a Queries.csv file
              <input type="file" accept=".csv,text/csv" className="sr-only" disabled={running} onChange={e => { void runFromFile(e.target.files?.[0]); e.target.value = '' }} />
            </label>
          </div>
        </div>
      )}

      {view && !showSetup && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }} className="mt-6">
          <h3 className="text-2xl font-bold">Results for {view.from_csv ? 'your uploaded file' : siteLabel(view.run.site_url)}</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="rounded-full border border-[#30353e] px-3 py-1 text-sm text-[#c4c8cf]">
              Week {view.week.week} of {view.week.of}: rows 1–{view.week.visible_rows} of {view.week.row_count}
            </span>
            <span className="rounded-full border border-[#30353e] px-3 py-1 text-sm text-[#c4c8cf]">
              {view.from_csv
                ? 'Uploaded file: top 100 queries by clicks. Date range and pages not available.'
                : `Pulled once on ${new Date(view.run.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. Not re-pulled.`}
            </span>
          </div>

          <div className="mt-5 overflow-x-auto rounded-xl border border-[#242a33]">
            <table className="w-full min-w-[56rem] border-collapse">
              <caption className="sr-only">Search query groups with clicks, impressions and estimated extra clicks</caption>
              <thead className="bg-[#14171c]">
                <tr>
                  <th scope="col" className={th}>Group</th>
                  <th scope="col" className={th}>Rows</th>
                  <th scope="col" className={th}>Clicks</th>
                  <th scope="col" className={th}>Impr.</th>
                  <th scope="col" className={th}>CTR</th>
                  <th scope="col" className={th}>Avg pos</th>
                  <th scope="col" className={th}>Striking 4–20</th>
                  <th scope="col" className={th}>Page 2</th>
                  <th scope="col" className={th}>Est. extra clicks (ESTIMATE)</th>
                  <th scope="col" className={th}>Regex</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map(row => (
                  <Fragment key={row.key}>
                    <tr className="border-t border-[#242a33]">
                      <th scope="row" className={`${td} font-medium text-left`}>{row.label}</th>
                      <td className={td}>{pair(row.items, g => num(g.rows))}</td>
                      <td className={td}>{pair(row.items, g => num(g.clicks))}</td>
                      <td className={td}>{pair(row.items, g => num(g.impressions))}</td>
                      <td className={td}>{pair(row.items, g => pct(g.ctr))}</td>
                      <td className={td}>{pair(row.items, g => one(g.avg_position))}</td>
                      <td className={td}>{pair(row.items, g => num(g.striking_distance))}</td>
                      <td className={td}>{pair(row.items, g => num(g.page_2))}</td>
                      <td className={td}>
                        {row.key === 'AI' ? '0 (GEO flag)' : pair(row.items, g => one(g.est_extra_clicks))}
                      </td>
                      <td className={td}>
                        <button
                          type="button"
                          aria-expanded={open === row.key}
                          onClick={() => setOpen(open === row.key ? '' : row.key)}
                          className="rounded-lg border border-[#30353e] px-3 py-1 text-sm font-medium text-[#e8eaed] transition-colors hover:border-[#ff4500]/60 hover:text-[#ff6a33]"
                        >
                          {open === row.key ? 'Hide' : 'Regex'}
                        </button>
                      </td>
                    </tr>
                    {open === row.key && (
                      <tr className="bg-[#101318]">
                        <td colSpan={10} className="px-4">
                          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
                            <RegexStrip entries={row.items.map(g => ({ name: g.group, pattern: g.pattern, filter_type: g.filter_type, finds: g.finds }))} />
                          </motion.div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mt-10 text-2xl font-bold">Top opportunities <span className="text-base font-normal text-[#9aa4b2]">(from your unlocked rows)</span></h3>
          {opportunities.length === 0 ? (
            <p className="mt-3 text-base text-[#9aa4b2]">No opportunities in your unlocked rows yet.</p>
          ) : (
            <div className="mt-3 overflow-x-auto rounded-xl border border-[#242a33]">
              <table className="w-full min-w-[56rem] border-collapse">
                <caption className="sr-only">Opportunities ranked by estimated extra clicks</caption>
                <thead className="bg-[#14171c]">
                  <tr>
                    <th scope="col" className={th}>#</th>
                    <th scope="col" className={th}>Query</th>
                    <th scope="col" className={th}>Page</th>
                    <th scope="col" className={th}>Pos</th>
                    <th scope="col" className={th}>Est. extra clicks</th>
                    <th scope="col" className={th}>Action</th>
                    <th scope="col" className={th}><span className="sr-only">Reddit</span></th>
                  </tr>
                </thead>
                <tbody>
                  {shownOpportunities.map((o, i) => (
                    <tr key={`${o.rank}-${o.query}`} className="border-t border-[#242a33]">
                      <td className={td}>{i + 1}</td>
                      <td className={`${td} font-medium`}>{o.query}</td>
                      <td className={`${td} max-w-[16rem] break-all text-[#9aa4b2]`}>{o.page ? siteLabel(o.page) : 'Not available from a file'}</td>
                      <td className={td}>{one(o.position)}</td>
                      <td className={td}>{o.est_extra_clicks === null ? 'Not enough data to estimate' : `+${one(o.est_extra_clicks)}`}</td>
                      <td className={`${td} max-w-[22rem] text-[#c4c8cf]`}>{o.action}</td>
                      <td className={td}>
                        <button type="button" disabled title="Coming next" className="rounded-lg border border-[#30353e] px-3 py-1.5 text-sm font-medium text-[#e8eaed] opacity-40">
                          Find Reddit threads
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {opportunities.length > 25 && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="mt-3 text-base text-[#9aa4b2] underline hover:text-[#ff6a33]">
              {showAll ? 'Show fewer' : `Show all ${opportunities.length}`}
            </button>
          )}

          <ul className="mt-8 list-disc space-y-1 pl-5 text-base text-[#9aa4b2]">
            <li>Extra-click numbers are estimates, not promises.</li>
            <li>A query can be in several groups, so group totals do not add up to the whole.</li>
            <li>Top 100 query + page rows only. Counts in the group table cover all 100 rows; the opportunity list shows only your unlocked rows.</li>
          </ul>
        </motion.div>
      )}
    </div>
  )
}
