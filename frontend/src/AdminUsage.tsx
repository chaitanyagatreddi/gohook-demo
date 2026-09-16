import { useEffect, useState } from 'react'
import { authHeaders } from './supabaseClient'

type EventRow = { user_id: string | null; event: string; ok: boolean; meta: Record<string, unknown>; created_at: string }
type UserRow = { id: string; email: string; created_at?: string; last_sign_in_at?: string }
type RedditRow = { user_id: string; reddit_username?: string; status?: string; meta?: { karma?: number }; last_synced_at?: string }
type VoiceRow = { user_id: string; source?: string; sample_count?: number }
type Usage = { rows: EventRow[]; users: UserRow[]; days: number; reddit: RedditRow[]; voices: VoiceRow[] }

const LABELS: Record<string, string> = {
  scan: 'Scans',
  question: 'Questions',
  ideate_angles: 'Ideate runs',
  ideate_draft: 'Ideate drafts',
  reply_draft: 'Replies drafted',
  board_add: 'Saved to board',
  voice_saved: 'Voice set up',
  reddit_connected: 'Reddit connected',
}

const day = (iso: string) => iso.slice(0, 10)
const ago = (iso?: string) => {
  if (!iso) return 'never'
  const hours = (Date.now() - new Date(iso).getTime()) / 36e5
  if (hours < 1) return 'just now'
  if (hours < 24) return `${Math.round(hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Owner-only view of what people are doing and where it breaks. */
export default function AdminUsage({ api }: { api: string }) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState('')
  const [days, setDays] = useState(30)

  useEffect(() => {
    let live = true
    ;(async () => {
      setError('')
      try {
        const res = await fetch(`${api}/admin/usage?days=${days}`, { headers: await authHeaders() })
        const data = await res.json()
        if (!res.ok) throw new Error(data.detail || 'Could not load usage.')
        if (live) setUsage(data)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'Could not load usage.')
      }
    })()
    return () => { live = false }
  }, [api, days])

  if (error) return <p className="text-sm text-red-400">{error}</p>
  if (!usage) return <p className="text-sm text-[#9aa4b2]">Loading…</p>

  const rows = usage.rows
  const byEvent = new Map<string, { total: number; failed: number; people: Set<string> }>()
  for (const row of rows) {
    const entry = byEvent.get(row.event) ?? { total: 0, failed: 0, people: new Set<string>() }
    entry.total += 1
    if (!row.ok) entry.failed += 1
    if (row.user_id) entry.people.add(row.user_id)
    byEvent.set(row.event, entry)
  }

  const perDay = new Map<string, number>()
  for (const row of rows) perDay.set(day(row.created_at), (perDay.get(day(row.created_at)) ?? 0) + 1)
  const days14 = [...Array(14)].map((_, i) => {
    const d = new Date(Date.now() - (13 - i) * 864e5).toISOString().slice(0, 10)
    return { d, n: perDay.get(d) ?? 0 }
  })
  const peak = Math.max(1, ...days14.map(x => x.n))

  const lastSeen = new Map<string, string>()
  for (const row of rows) if (row.user_id && !lastSeen.has(row.user_id)) lastSeen.set(row.user_id, row.created_at)

  const failures = rows.filter(r => !r.ok).slice(0, 12)
  const active = new Set(rows.filter(r => r.user_id).map(r => r.user_id as string))
  const reddit = new Map((usage.reddit ?? []).map(r => [r.user_id, r]))
  const voices = new Map((usage.voices ?? []).map(v => [v.user_id, v]))
  const connected = usage.users.filter(u => reddit.get(u.id)?.status === 'active').length

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        {[7, 30, 90].map(n => (
          <button
            key={n}
            onClick={() => setDays(n)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${days === n ? 'bg-[#ff4500] text-white' : 'border border-[#30353e] text-[#9aa4b2] hover:text-[#e8eaed]'}`}
          >
            {n} days
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Accounts', value: usage.users.length },
          { label: 'Did something', value: active.size },
          { label: 'Actions', value: rows.length },
          { label: 'Reddit connected', value: `${connected}/${usage.users.length}` },
          { label: 'Failed actions', value: rows.filter(r => !r.ok).length },
        ].map(card => (
          <div key={card.label} className="rounded-xl border border-[#242a33] bg-[#14171c] p-4">
            <p className="text-[11px] uppercase tracking-[0.08em] text-[#858b95]">{card.label}</p>
            <p className="mt-1 text-2xl font-semibold text-[#e8eaed] tabular-nums">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-[#242a33] bg-[#14171c] p-4">
        <p className="text-[11px] uppercase tracking-[0.08em] text-[#858b95]">Last 14 days</p>
        <div className="mt-3 flex h-20 items-end gap-1">
          {days14.map(({ d, n }) => (
            <div key={d} className="flex-1" title={`${d}: ${n}`}>
              <div className="rounded-t bg-[#ff4500]/70" style={{ height: `${(n / peak) * 72}px`, minHeight: n ? 2 : 0 }} />
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-[#242a33] bg-[#14171c] p-4">
        <p className="text-[11px] uppercase tracking-[0.08em] text-[#858b95]">What people do</p>
        {byEvent.size === 0 ? (
          <p className="mt-2 text-sm text-[#9aa4b2]">Nothing yet in this window.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <tbody>
              {[...byEvent.entries()].sort((a, b) => b[1].total - a[1].total).map(([name, e]) => (
                <tr key={name} className="border-t border-[#242a33] first:border-0">
                  <td className="py-2 text-[#e8eaed]">{LABELS[name] ?? name}</td>
                  <td className="py-2 text-right tabular-nums text-[#9aa4b2]">{e.people.size} people</td>
                  <td className="py-2 text-right tabular-nums text-[#e8eaed]">{e.total}</td>
                  <td className={`py-2 text-right tabular-nums ${e.failed ? 'text-amber-300' : 'text-[#6b7280]'}`}>{e.failed ? `${e.failed} failed` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {failures.length > 0 && (
        <div className="rounded-xl border border-amber-300/25 bg-amber-300/5 p-4">
          <p className="text-[11px] uppercase tracking-[0.08em] text-amber-300">Where it broke</p>
          <ul className="mt-2 space-y-1.5">
            {failures.map((row, i) => (
              <li key={i} className="text-xs text-[#d7dbe1]">
                <span className="text-[#9aa4b2]">{ago(row.created_at)}</span> · {LABELS[row.event] ?? row.event}
                {row.meta?.why ? ` · ${String(row.meta.why).slice(0, 90)}` : ''}
                {row.meta?.reasons ? ` · ${(row.meta.reasons as string[]).join(', ')}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-xl border border-[#242a33] bg-[#14171c] p-4">
        <p className="text-[11px] uppercase tracking-[0.08em] text-[#858b95]">People</p>
        <table className="mt-3 w-full text-sm">
          <tbody>
            {usage.users
              .slice()
              .sort((a, b) => (lastSeen.get(b.id) ?? '').localeCompare(lastSeen.get(a.id) ?? ''))
              .map(user => (
                <tr key={user.id} className="border-t border-[#242a33] first:border-0 align-top">
                  <td className="py-2 text-[#e8eaed]">
                    {user.email}
                    <span className="block text-[11px] text-[#6b7280]">joined {ago(user.created_at)} · signed in {ago(user.last_sign_in_at)}</span>
                  </td>
                  <td className="py-2 text-right text-xs">
                    {reddit.get(user.id)?.status === 'active'
                      ? <span className="text-[#50c878]">u/{reddit.get(user.id)?.reddit_username}{reddit.get(user.id)?.meta?.karma !== undefined ? ` · ${reddit.get(user.id)?.meta?.karma} karma` : ''}</span>
                      : reddit.has(user.id)
                        ? <span className="text-amber-300">Reddit {reddit.get(user.id)?.status}</span>
                        : <span className="text-[#6b7280]">no Reddit</span>}
                  </td>
                  <td className="py-2 text-right text-xs">
                    {voices.has(user.id)
                      ? <span className="text-[#50c878]">voice ({voices.get(user.id)?.source})</span>
                      : <span className="text-[#6b7280]">no voice</span>}
                  </td>
                  <td className="py-2 text-right text-xs">
                    {lastSeen.has(user.id)
                      ? <span className="text-[#50c878]">active {ago(lastSeen.get(user.id))}</span>
                      : <span className="text-[#6b7280]">no actions</span>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
