import { useState } from 'react'

export default function VoiceProfile() {
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState(false)

  return <div className="vp-root">
    <button className={`vp-trigger ${saved ? 'vp-ready' : ''}`} onClick={() => setOpen(true)}>
      <span>{saved ? '✓' : '✦'}</span>{saved ? 'Voice ready' : 'Your voice'}
    </button>
    {open && <div className="vp-backdrop" onMouseDown={() => setOpen(false)}>
      <section className="vp-dialog" onMouseDown={event => event.stopPropagation()}>
        <div className="vp-heading"><div><span>WRITING PROFILE</span><h2>Show GoHook how you write</h2></div><button onClick={() => setOpen(false)} aria-label="Close">×</button></div>
        <p className="vp-intro">Add something you wrote. GoHook will match your tone when it drafts posts and replies.</p>
        <div className="vp-field"><label>A few lines you wrote</label><textarea rows={6} placeholder="Paste 3–10 lines of your writing…"/><small>We save the writing style, not a large document.</small></div>
        <div className="vp-signal"><span>✦</span><p><strong>GoHook will learn</strong> sentence length, directness, vocabulary and how you open and close a thought.</p></div>
        <button className="vp-save" onClick={() => { setSaved(true); setOpen(false) }}>Save my voice →</button>
      </section>
    </div>}
  </div>
}
