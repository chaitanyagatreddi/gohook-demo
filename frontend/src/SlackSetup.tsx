import { useEffect, useState } from 'react'
import { authHeaders } from './supabaseClient'

/** Send audit alerts to a Slack channel through an incoming webhook. */
export default function SlackSetup({ api, signedIn }: { api: string; signedIn: boolean }) {
  const [connected, setConnected] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!signedIn) { setConnected(false); return }
    let live = true
    ;(async () => {
      try {
        const res = await fetch(`${api}/slack`, { headers: await authHeaders() })
        const data = await res.json()
        if (live) setConnected(Boolean(data.connected))
      } catch { /* not connected is the safe assumption */ }
    })()
    return () => { live = false }
  }, [api, signedIn])

  async function connect() {
    setBusy(true); setError('')
    try {
      const res = await fetch(`${api}/slack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ webhook_url: url }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not connect Slack.')
      setConnected(true); setUrl('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect Slack.')
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true); setError('')
    try {
      await fetch(`${api}/slack`, { method: 'DELETE', headers: await authHeaders() })
      setConnected(false)
    } catch {
      setError('Could not disconnect.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-[#242a33] bg-[#14171c] rounded-xl p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-[#e8eaed]">Slack alerts</p>
        <span className={`text-xs px-2 py-0.5 rounded ${connected ? 'bg-green-500/10 text-green-400' : 'bg-[#242a33] text-[#9aa4b2]'}`}>
          {connected ? 'Connected' : 'Not connected'}
        </span>
      </div>
      <p className="mt-1 text-xs text-[#9aa4b2]">
        Your score and the threads you are missing, posted to a channel every time an audit runs.
      </p>

      {!signedIn ? (
        <p className="mt-3 text-xs text-[#9aa4b2]">Sign in to connect Slack.</p>
      ) : connected ? (
        <button onClick={disconnect} disabled={busy} className="mt-3 text-xs text-[#9aa4b2] transition-colors hover:text-red-400 disabled:opacity-40">
          {busy ? 'Disconnecting…' : 'Disconnect'}
        </button>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://hooks.slack.com/services/…"
            className="rounded-lg border border-[#242a33] bg-[#0b0d10] px-3 py-2 text-xs text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={connect}
              disabled={busy || !url.trim()}
              className="rounded-lg bg-[#ff4500] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#ff6a33] disabled:opacity-40"
            >
              {busy ? 'Checking…' : 'Connect Slack'}
            </button>
            <a
              href="https://api.slack.com/messaging/webhooks"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[#ff6a33] hover:underline"
            >
              Where do I get this? ↗
            </a>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}
