import { useEffect, useState } from 'react'

const CHECK_EVERY_MS = 5 * 60 * 1000

/**
 * A tab left open keeps running the build it loaded, so someone can sit on
 * yesterday's app all day. index.html names the current bundle, so comparing
 * it with ours is enough to know a new one shipped.
 */
export default function NewVersionBar() {
  const [stale, setStale] = useState(false)

  useEffect(() => {
    const mine = document.querySelector<HTMLScriptElement>('script[src*="/assets/"]')?.src
    if (!mine) return

    async function check() {
      if (document.hidden) return
      try {
        const html = await fetch(`/?v=${Date.now()}`, { cache: 'no-store' }).then(r => r.text())
        const live = html.match(/\/assets\/[^"']+\.js/)?.[0]
        if (live && mine && !mine.endsWith(live)) setStale(true)
      } catch { /* offline, or the check itself failed: say nothing */ }
    }

    const timer = setInterval(check, CHECK_EVERY_MS)
    window.addEventListener('focus', check)
    return () => { clearInterval(timer); window.removeEventListener('focus', check) }
  }, [])

  if (!stale) return null

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-[#ff4500]/40 bg-[#14171c] px-4 py-2 shadow-[0_12px_30px_rgba(0,0,0,0.4)]">
      <span className="text-xs text-[#e8eaed]">A newer version of GoHook is ready.</span>
      <button onClick={() => location.reload()} className="ml-3 text-xs font-semibold text-[#ff6a33] hover:underline">
        Refresh
      </button>
    </div>
  )
}
