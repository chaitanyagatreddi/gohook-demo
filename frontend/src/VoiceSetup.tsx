import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'

export type VoiceStyle = {
  sentence_length?: string
  directness?: string
  vocabulary?: string
  tone?: string
  openers?: string
  closers?: string
  punctuation?: string
  avoid?: string[]
}

export type SavedVoice = { style: VoiceStyle; sample_count: number; source: string; updated_at?: string }

type Analysis = {
  style: VoiceStyle
  readback: string[]
  sample_words: number
  source?: string
  posts_used?: number
  preview: { idea: string; plain: string; voiced: string }
}

const EASE = [0.22, 0.61, 0.36, 1] as const

/**
 * "Your voice": paste a few lines or use your own Reddit writing, see what
 * GoHook picked up and how a draft changes, then save. Only the style summary
 * is stored, never the writing itself.
 */
export default function VoiceSetup({
  api,
  authHeaders,
  signedIn,
  redditConnected,
  onSaved,
}: {
  api: string
  authHeaders: () => Promise<Record<string, string>>
  signedIn: boolean
  redditConnected?: boolean
  onSaved?: (voice: SavedVoice | null) => void
}) {
  const [saved, setSaved] = useState<SavedVoice | null>(null)
  const [text, setText] = useState('')
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [busy, setBusy] = useState<'' | 'reading' | 'reddit' | 'saving' | 'deleting'>('')
  const [error, setError] = useState('')
  const [showPlain, setShowPlain] = useState(false)

  useEffect(() => {
    if (!signedIn) { setSaved(null); return }
    let live = true
    ;(async () => {
      try {
        const res = await fetch(`${api}/voice`, { headers: await authHeaders() })
        const data = await res.json()
        if (live) setSaved(data.voice ?? null)
      } catch { /* a missing voice is not an error worth showing */ }
    })()
    return () => { live = false }
  }, [api, signedIn])

  async function call(path: string, body?: unknown, method = 'POST') {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.detail || 'Something went wrong. Please try again.')
    return data
  }

  async function readWriting() {
    setError(''); setBusy('reading')
    try {
      setAnalysis(await call('/voice/analyze', { text }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read your writing.')
    } finally { setBusy('') }
  }

  async function readFromReddit() {
    setError(''); setBusy('reddit')
    try {
      setAnalysis(await call('/voice/from-reddit'))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read your Reddit writing.')
    } finally { setBusy('') }
  }

  async function saveVoice() {
    if (!analysis) return
    setError(''); setBusy('saving')
    try {
      const data = await call('/voice', {
        style: analysis.style,
        sample_count: analysis.sample_words,
        source: analysis.source === 'reddit' ? 'reddit' : 'paste',
      })
      setSaved(data.voice ?? null)
      onSaved?.(data.voice ?? null)
      setAnalysis(null); setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your voice.')
    } finally { setBusy('') }
  }

  async function deleteVoice() {
    setError(''); setBusy('deleting')
    try {
      await call('/voice', undefined, 'DELETE')
      setSaved(null); onSaved?.(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete your voice.')
    } finally { setBusy('') }
  }

  const words = text.trim().split(/\s+/).filter(Boolean).length
  const readingSomething = busy === 'reading' || busy === 'reddit'

  return (
    <div className="border border-[#242a33] bg-[#14171c] rounded-xl p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-[#e8eaed]">Your voice</p>
        <span className={`text-xs px-2 py-0.5 rounded ${saved ? 'bg-green-500/10 text-green-400' : 'bg-[#242a33] text-[#9aa4b2]'}`}>
          {saved ? 'Ready' : 'Not set up'}
        </span>
      </div>
      <p className="mt-1 text-xs text-[#9aa4b2]">
        Add something you wrote. GoHook matches your tone when it drafts posts and replies. We keep the writing style, not the text.
      </p>

      {!signedIn ? (
        <p className="mt-3 text-xs text-[#9aa4b2]">Sign in to set up your voice.</p>
      ) : saved && !analysis ? (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: EASE }} className="mt-3">
          <div className="flex flex-wrap gap-1.5">
            {[saved.style.sentence_length && `${saved.style.sentence_length} sentences`, saved.style.directness, saved.style.vocabulary && `${saved.style.vocabulary} words`, saved.style.tone]
              .filter(Boolean)
              .map(chip => (
                <span key={String(chip)} className="rounded-full border border-[#30353e] bg-[#0b0d10] px-2.5 py-1 text-[11px] text-[#d7dbe1]">{String(chip)}</span>
              ))}
          </div>
          <p className="mt-2 text-[11px] text-[#6b7280]">
            From {saved.source === 'reddit' ? 'your Reddit writing' : 'writing you pasted'}
            {saved.sample_count ? ` · ${saved.sample_count} words read` : ''}
          </p>
          <div className="mt-3 flex gap-2">
            <button onClick={() => setSaved(null)} className="border border-[#30353e] hover:border-[#ff4500]/60 text-[#e8eaed] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors">
              Update my voice
            </button>
            <button onClick={deleteVoice} disabled={busy === 'deleting'} className="text-xs text-[#9aa4b2] hover:text-red-400 px-2 transition-colors disabled:opacity-40">
              {busy === 'deleting' ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </motion.div>
      ) : (
        <div className="mt-3">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={5}
            placeholder="Paste 3–10 lines of your writing…"
            className="w-full bg-[#0b0d10] border border-[#242a33] rounded-lg px-3 py-2 text-sm text-[#e8eaed] placeholder-[#6b7280] focus:outline-none focus:ring-2 focus:ring-[#ff4500]/60 resize-none"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-[#6b7280]">{words} words</span>
            <button
              onClick={readWriting}
              disabled={readingSomething || words < 40}
              title={words < 40 ? 'Add at least 40 words' : 'Read my writing'}
              className="ml-auto bg-[#ff4500] hover:bg-[#ff6a33] text-white px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors"
            >
              {busy === 'reading' ? 'Reading…' : 'Read my writing →'}
            </button>
            {redditConnected && (
              <button
                onClick={readFromReddit}
                disabled={readingSomething}
                className="border border-[#30353e] hover:border-[#ff4500]/60 text-[#e8eaed] px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors"
              >
                {busy === 'reddit' ? 'Reading Reddit…' : 'Use my Reddit writing'}
              </button>
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

      <AnimatePresence mode="wait">
        {readingSomething && (
          <motion.div
            key="reading"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="mt-3 space-y-2"
          >
            {[0, 1, 2].map(i => (
              <motion.div
                key={i}
                className="h-3 rounded bg-[#242a33]"
                style={{ width: `${70 - i * 15}%` }}
                animate={{ opacity: [0.35, 0.8, 0.35] }}
                transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.15 }}
              />
            ))}
          </motion.div>
        )}

        {analysis && !readingSomething && (
          <motion.div
            key="analysis"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: EASE }}
            className="mt-4 space-y-3"
          >
            <div className="rounded-lg border border-[#ff4500]/25 bg-[#ff4500]/5 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#ff6a33]">What GoHook picked up</p>
              <ul className="mt-2 space-y-1">
                {analysis.readback.map((line, i) => (
                  <motion.li
                    key={line}
                    initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.06 * i, duration: 0.25, ease: EASE }}
                    className="text-xs text-[#d7dbe1]"
                  >
                    {line}
                  </motion.li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-[#9aa4b2]">
                {analysis.source === 'reddit'
                  ? `Read from ${analysis.posts_used ?? 0} of your Reddit posts (${analysis.sample_words} words).`
                  : `Read from ${analysis.sample_words} words.`}
              </p>
            </div>

            <div className="rounded-lg border border-[#242a33] bg-[#0b0d10] p-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#9aa4b2]">
                  Same post, {showPlain ? 'plain' : 'in your voice'}
                </p>
                <button onClick={() => setShowPlain(p => !p)} className="text-[11px] text-[#ff6a33] hover:underline">
                  {showPlain ? 'Show mine' : 'Compare plain'}
                </button>
              </div>
              <AnimatePresence mode="wait">
                <motion.p
                  key={showPlain ? 'plain' : 'voiced'}
                  initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[#d7dbe1]"
                >
                  {showPlain ? analysis.preview.plain : analysis.preview.voiced}
                </motion.p>
              </AnimatePresence>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={saveVoice}
                disabled={busy === 'saving'}
                className="bg-[#ff4500] hover:bg-[#ff6a33] text-white px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors"
              >
                {busy === 'saving' ? 'Saving…' : 'Save my voice →'}
              </button>
              <button onClick={() => { setAnalysis(null); setError('') }} className="text-xs text-[#9aa4b2] hover:text-[#e8eaed] px-2 transition-colors">
                Try different writing
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
