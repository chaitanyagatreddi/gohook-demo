import { useEffect, useState } from 'react'
import { authHeaders } from './supabaseClient'

type EventRow = { user_id: string | null; event: string; ok: boolean; meta: Record<string, unknown>; created_at: string }
type UserRow = {
  id: string; email: string; created_at?: string; last_sign_in_at?: string
  full_name?: string; company?: string; linkedin_url?: string; role?: string; goal?: string
}
type RedditRow = { user_id: string; reddit_username?: string; status?: string; meta?: { karma?: number }; last_synced_at?: string }
type VoiceRow = { user_id: string; source?: string; sample_count?: number }
type Member = { email: string; role: string; added_by?: string }
type Usage = { rows: EventRow[]; users: UserRow[]; days: number; reddit: RedditRow[]; voices: VoiceRow[]; role?: string }

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
  const [team, setTeam] = useState<Member[]>([])
  const [teamEmail, setTeamEmail] = useState('')
  const [teamError, setTeamError] = useState('')

  async function loadTeam() {
    try {
      const res = await fetch(`${api}/admin/team`, { headers: await authHeaders() })
      const data = await res.json()
      if (res.ok) setTeam(data.members ?? [])
    } catch { /* the rest of the page still works */ }
  }

  useEffect(() => { void loadTeam() }, [api])

  async function addMember() {
    setTeamError('')
    try {
      const res = await fetch(`${api}/admin/team`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ email: teamEmail, role: 'admin' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not add them.')
      setTeamEmail('')
      await loadTeam()
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : 'Could not add them.')
    }
  }

  async function removeMember(email: string) {
    setTeamError('')
    try {
      const res = await fetch(`${api}/admin/team/${encodeURIComponent(email)}`, { method: 'DELETE', headers: await authHeaders() })
      if (!res.ok) throw new Error((await res.json()).detail || 'Could not remove them.')
      await loadTeam()
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : 'Could not remove them.')
    }
  }

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
        <div className="flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-[0.08em] text-[#858b95]">Team</p>
          <span className="text-[11px] text-[#6b7280]">super admins manage the team · admins can view</span>
        </div>
        <table className="mt-3 w-full text-sm">
          <tbody>
            {team.map(member => (
              <tr key={member.email} className="border-t border-[#242a33] first:border-0">
                <td className="py-2 text-[#e8eaed]">{member.email}</td>
                <td className="py-2 text-right">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${member.role === 'superadmin' ? 'bg-[#ff4500]/15 text-[#ff6a33]' : 'bg-[#242a33] text-[#9aa4b2]'}`}>{member.role === 'superadmin' ? 'super admin' : member.role}</span>
                </td>
                <td className="py-2 text-right">
                  {usage.role === 'superadmin' && member.added_by !== 'settings' && (
                    <button onClick={() => removeMember(member.email)} className="text-[11px] text-[#6b7280] hover:text-red-400">Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {usage.role === 'superadmin' && (
          <div className="mt-3 flex gap-2">
            <input
              type="email"
              value={teamEmail}
              onChange={e => setTeamEmail(e.target.value)}
              placeholder="teammate@email.com"
              className="flex-1 rounded-lg border border-[#242a33] bg-[#0b0d10] px-3 py-2 text-xs text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
            />
            <button onClick={addMember} disabled={!teamEmail.trim()} className="rounded-lg bg-[#ff4500] px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#ff6a33] disabled:opacity-40">
              Add as admin
            </button>
          </div>
        )}
        {teamError && <p className="mt-2 text-xs text-red-400">{teamError}</p>}
      </div>

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
                    {(user.full_name || user.company) && (
                      <span className="block text-[11px] text-[#9aa4b2]">
                        {user.full_name}{user.full_name && user.company ? ' · ' : ''}{user.company}
                        {user.role ? ` · ${user.role}` : ''}{user.goal ? ` · ${user.goal}` : ''}
                        {user.linkedin_url ? <> · <a href={user.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-[#ff6a33] hover:underline">LinkedIn</a></> : ''}
                      </span>
                    )}
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
