import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { authHeaders } from './supabaseClient'

type Site = { url: string; permission: string }

/** Connect Google Search Console (read-only). Shows the person's sites once connected. */
export default function SearchConsoleSetup({ api, signedIn }: { api: string; signedIn: boolean }) {
  const [state, setState] = useState<'checking' | 'not_connected' | 'ok' | 'needs_reconnect'>('checking')
  const [sites, setSites] = useState<Site[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  // Coming back from Google: ?gsc=connected, or ?gsc=error&message=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const result = params.get('gsc')
    if (!result) return
    if (result === 'connected') setMessage('Search Console connected.')
    else setError(params.get('message') || 'Could not connect Search Console.')
    params.delete('gsc'); params.delete('message')
    const rest = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''))
  }, [])

  useEffect(() => {
    if (!signedIn) { setState('not_connected'); setSites([]); return }
    let live = true
    ;(async () => {
      try {
        const res = await fetch(`${api}/gsc/status`, { headers: await authHeaders() })
        const data = await res.json()
        if (!live) return
        setState(data.state === 'ok' ? 'ok' : data.state === 'needs_reconnect' ? 'needs_reconnect' : 'not_connected')
        if (data.state === 'ok') {
          const sitesRes = await fetch(`${api}/gsc/sites`, { headers: await authHeaders() })
          const sitesData = await sitesRes.json()
          if (!live) return
          if (sitesRes.ok) setSites(sitesData.sites || [])
          else if (sitesRes.status === 409) { setState('needs_reconnect'); setError(sitesData.detail || '') }
        }
      } catch { /* not connected is the safe assumption */ if (live) setState('not_connected') }
    })()
    return () => { live = false }
  }, [api, signedIn])

  async function connect() {
    setBusy(true); setError(''); setMessage('')
    try {
      const res = await fetch(`${api}/gsc/connect`, { method: 'POST', headers: await authHeaders() })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not start connecting Search Console.')
      window.location.href = data.url
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start connecting Search Console.')
      setBusy(false)
    }
  }

  const badge = state === 'ok' ? 'Connected' : state === 'needs_reconnect' ? 'Needs reconnect' : state === 'checking' ? 'Checking…' : 'Not connected'
  const badgeStyle = state === 'ok' ? 'bg-green-500/10 text-green-400' : state === 'needs_reconnect' ? 'bg-amber-500/10 text-amber-400' : 'bg-[#242a33] text-[#9aa4b2]'

  return (
    <div className="border border-[#242a33] bg-[#14171c] rounded-xl p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-[#e8eaed]">Google Search Console</p>
        <span className={`text-xs px-2 py-0.5 rounded ${badgeStyle}`}>{badge}</span>
      </div>
      <p className="mt-1 text-xs text-[#9aa4b2]">
        Read-only. GoHook reads your top search queries and the page each one shows on. It never changes anything in Search Console.
      </p>

      {!signedIn ? (
        <p className="mt-3 text-xs text-[#9aa4b2]">Sign in to connect Search Console.</p>
      ) : state === 'ok' ? (
        <div className="mt-3">
          <p className="text-xs text-[#9aa4b2]">{sites.length ? `Your sites (${sites.length}):` : 'No sites found on this Google account.'}</p>
          <ul className="mt-1 space-y-1">
            {sites.map(site => (
              <li key={site.url} className="text-xs text-[#e8eaed]">{site.url} <span className="text-[#6b7280]">· {site.permission}</span></li>
            ))}
          </ul>
        </div>
      ) : (
        <motion.button
          onClick={connect}
          disabled={busy || state === 'checking'}
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
          className="mt-4 inline-flex items-center gap-2 rounded-lg px-[18px] py-[10px] text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Opening Google…' : state === 'needs_reconnect' ? 'Reconnect Google' : 'Connect Google Search Console'}
          <motion.span variants={{ rest: { x: 0 }, hover: { x: 4 } }} transition={{ type: 'spring', bounce: 0.28, duration: 0.42 }}>→</motion.span>
        </motion.button>
      )}
      {message && <p className="mt-2 text-xs text-green-400">{message}</p>}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}
