import { useState } from 'react'

type Stage = 'source' | 'angles' | 'draft'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

type Angle = {
  id: string
  title: string
  hook: string
  subreddit: string
  post_type: string
  why_fits: string
  promo_risk: string
  include_link: string
}
type Subreddit = { name: string; example_threads: string[]; thread_urls: string[] }
type IdeasResult = { source_title: string; source_preview: string; subreddits: Subreddit[]; angles: Angle[] }
type DraftResult = { title: string; draft: string; word_count: number; tone: string; link_placement: string }

const cap = (text: string) => text ? text.charAt(0).toUpperCase() + text.slice(1) : text

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || 'Something went wrong. Please try again.')
  return data as T
}


export default function IdeateWireframe() {
  const [stage, setStage] = useState<Stage>('source')
  const [url, setUrl] = useState('')
  const [takeaway, setTakeaway] = useState('')
  const [selected, setSelected] = useState<string>('')
  const [ideas, setIdeas] = useState<IdeasResult | null>(null)
  const [draft, setDraft] = useState<DraftResult | null>(null)
  const [loading, setLoading] = useState<'' | 'ideas' | 'draft'>('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const selectedAngle = ideas?.angles.find(angle => angle.id === selected) || null

  const findAngles = async () => {
    setLoading('ideas'); setError(''); setDraft(null)
    try {
      const result = await postJson<IdeasResult>('/ideate/angles', { url: url.trim(), takeaway })
      setIdeas(result)
      setSelected(result.angles[0]?.id || '')
      setStage('angles')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not get post ideas.')
    } finally {
      setLoading('')
    }
  }

  const createDraft = async () => {
    if (!selectedAngle) return
    setLoading('draft'); setError(''); setCopied(false)
    const sub = ideas?.subreddits.find(item => item.name.toLowerCase() === selectedAngle.subreddit.toLowerCase())
    try {
      const result = await postJson<DraftResult>('/ideate/draft', {
        url: url.trim(), angle: selectedAngle, takeaway, example_threads: sub?.example_threads || [],
      })
      setDraft(result)
      setStage('draft')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not write the draft.')
    } finally {
      setLoading('')
    }
  }

  const copyDraft = async () => {
    if (!draft) return
    try { await navigator.clipboard.writeText(`${draft.title}\n\n${draft.draft}`); setCopied(true) } catch { /* blocked */ }
  }

  const reset = () => { setStage('source'); setIdeas(null); setDraft(null); setError('') }

  return (
    <div className="iw-embedded">

      <main className="iw-main">
        <header className="iw-header">
          <div>
            <span className="iw-eyebrow">IDEATE FROM A URL</span>
            <h1>Share your page on Reddit without getting removed.</h1>
            <p>Paste a link. We find the subreddits already talking about it and give you post ideas that start a discussion, not a self-promo.</p>
          </div>
        </header>

        <section className="iw-source-card">
          <label htmlFor="source-url">Link to your blog, launch or changelog</label>
          <div className="iw-url-row">
            <input id="source-url" value={url} placeholder="https://yourblog.com/your-post" onChange={e => { setUrl(e.target.value); setStage('source'); setIdeas(null); setDraft(null) }} />
            <button onClick={findAngles} disabled={!url.trim() || loading !== ''}>{loading === 'ideas' ? 'Reading your page…' : stage === 'source' ? 'Get post ideas →' : 'Link checked ✓'}</button>
          </div>
          <label htmlFor="takeaway">What's the one thing you want readers to remember? <span>Optional</span></label>
          <textarea id="takeaway" rows={2} value={takeaway} placeholder="e.g. AI works better when it improves human judgment instead of replacing it." onChange={e => setTakeaway(e.target.value)} />
          {error && <p className="iw-error" role="alert">{error}</p>}
        </section>

        {stage === 'source' && (
          <section className="iw-empty">
            <div className="iw-empty-icon">↗</div>
            <h2>One link, several posts people want to join</h2>
            <p>You'll get 3–5 post ideas, the subreddits to post them in, and real threads to match the tone.</p>
          </section>
        )}

        {stage !== 'source' && ideas && (
          <div className="iw-workspace">
            <section className="iw-content">
              <div className="iw-section-head">
                <div><span className="iw-eyebrow">YOUR LINK</span><h2>{ideas.source_title}</h2></div>
                <button className="iw-text-button" onClick={reset}>Change link</button>
              </div>
              <p className="iw-preview">{ideas.source_preview}</p>

              <div className="iw-section-head iw-angle-heading">
                <div><span className="iw-eyebrow">POST IDEAS</span><h2>Pick the discussion you want to start</h2></div>
                <span className="iw-count">{ideas.angles.length} ideas</span>
              </div>

              <div className="iw-angle-list">
                {ideas.angles.map(angle => (
                  <button key={angle.id} className={`iw-angle ${selected === angle.id ? 'iw-angle-selected' : ''}`} onClick={() => { setSelected(angle.id); setStage('angles') }}>
                    <div className="iw-radio">{selected === angle.id ? '●' : '○'}</div>
                    <div className="iw-angle-copy">
                      <div className="iw-angle-meta"><span>{cap(angle.post_type)}</span><span>{angle.subreddit}</span></div>
                      <h3>{angle.title}</h3>
                      <p>{angle.hook}</p>
                      <div className="iw-angle-details"><span>Why it fits: {angle.why_fits}</span><span>Promo risk: {cap(angle.promo_risk)}</span><span>{cap(angle.include_link)}</span></div>
                    </div>
                  </button>
                ))}
              </div>
              <button className="iw-primary iw-draft-cta" onClick={createDraft} disabled={!selectedAngle || loading !== ''}>{loading === 'draft' ? 'Writing the draft…' : 'Draft this idea →'}</button>

              {stage === 'draft' && draft && (
                <div className="iw-draft">
                  <div className="iw-section-head"><div><span className="iw-eyebrow">DRAFT</span><h2>{draft.title}</h2></div><button className="iw-text-button" onClick={copyDraft}>{copied ? 'Copied ✓' : 'Copy'}</button></div>
                  {draft.draft.split(/\n\s*\n/).map((para, i) => <p key={i}>{para}</p>)}
                  <div className="iw-draft-footer"><span>{draft.word_count} words</span><span>{draft.link_placement}</span><span>Check {selectedAngle?.subreddit || 'the subreddit'} rules before posting</span></div>
                </div>
              )}
            </section>

            <aside className="iw-evidence">
              <span className="iw-eyebrow">WHERE IT FITS</span>
              <h2>Where people already talk about it</h2>
              <p>Real threads on this topic, so you can match the tone.</p>
              {ideas.subreddits.length === 0 && <p>No matching discussions found. Check each subreddit before posting.</p>}
              {ideas.subreddits.map(sub => (
                <a className="iw-community" key={sub.name} href={sub.thread_urls[0]} target="_blank" rel="noopener noreferrer">
                  <div><strong>{sub.name}</strong><span>{sub.example_threads.length} related {sub.example_threads.length === 1 ? 'thread' : 'threads'}</span></div>
                  <span>↗</span>
                </a>
              ))}
              <div className="iw-note"><span>!</span><p>GoHook never posts for you. You review and post yourself.</p></div>
            </aside>
          </div>
        )}
      </main>
    </div>
  )
}
