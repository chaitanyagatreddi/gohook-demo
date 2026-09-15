import { useState } from 'react'
import VoiceProfile from './VoiceProfile'

type DemoState = 'passed' | 'weak' | 'withheld' | 'zero' | 'running' | 'mobile'

const demos: { id: DemoState; label: string }[] = [
  { id: 'passed', label: 'All passed' },
  { id: 'weak', label: 'Answer shown' },
  { id: 'withheld', label: 'Answer held back' },
  { id: 'zero', label: 'Zero threads' },
  { id: 'running', label: 'Running' },
  { id: 'mobile', label: 'Mobile' },
]

const evidence = [
  'How founders research their market before launch',
  'What Reddit taught us about early customer discovery',
  'Finding useful conversations without spamming communities',
]

function PassedGroup({ count }: { count: number }) {
  return (
    <div className="qr-passed-group">
      <span className="qr-status-icon qr-pass">✓</span>
      <div><strong>{count} checks passed</strong><p>Question understood, threads searched and results verified</p></div>
      <button aria-label="Show passed checks">⌄</button>
    </div>
  )
}

function Meter({ value, target }: { value: number; target: number }) {
  return (
    <div className="qr-meter-wrap">
      <div className="qr-meter-label"><span>Evidence strength</span><strong>{value} <small>of {target} needed</small></strong></div>
      <div className="qr-meter"><span style={{ width: `${Math.min(100, value / target * 100)}%` }} /></div>
    </div>
  )
}

function WeakStep({ number, title, reason, detail, open, onToggle }: { number: string; title: string; reason: string; detail: string; open: boolean; onToggle: () => void }) {
  return (
    <button className="qr-weak-step" onClick={onToggle} aria-expanded={open}>
      <span className="qr-status-icon qr-low">!</span>
      <div className="qr-step-copy">
        <div><span className="qr-step-number">{number}</span><strong>{title}</strong><span className="qr-status-label">LOW PROOF</span></div>
        <p>{reason}</p>
        {open && <div className="qr-detail">{detail}</div>}
      </div>
      <span className={`qr-chevron ${open ? 'qr-open' : ''}`}>⌄</span>
    </button>
  )
}

export default function QuestionRunWireframe() {
  const [demo, setDemo] = useState<DemoState>('withheld')
  const [openStep, setOpenStep] = useState('04')
  const [showEvidence, setShowEvidence] = useState(false)
  const [editing, setEditing] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  const mobile = demo === 'mobile'
  const passed = demo === 'passed'
  const weak = demo === 'weak'
  const zero = demo === 'zero'
  const running = demo === 'running'
  const value = passed ? 82 : weak ? 52 : zero ? 0 : 7
  const threads = passed ? 6 : weak ? 3 : zero ? 0 : 1

  const title = passed ? 'This answer has enough proof' : weak ? 'Useful answer, with limits' : zero ? 'No Reddit evidence found' : running ? 'Checking the evidence' : 'Not enough proof to answer'
  const description = passed
    ? '6 verified threads support the answer across 4 communities.'
    : weak
      ? 'The answer is shown, but some claims have limited support.'
      : zero
        ? 'Reddit does not appear to discuss this question yet.'
        : running
          ? 'GoHook is checking relevance, coverage and claim support.'
          : 'We found 1 relevant thread. We need at least 3 before we trust an answer.'

  return (
    <div className="qr-demo-page">
      <header className="qr-demo-header">
        <div><span className="qr-logo">⌘</span><strong>GoHook</strong><span>Question Run · design review</span></div>
        <div className="qr-header-actions"><VoiceProfile /><a href="?wireframe=ideate">Ideate wireframe ↗</a></div>
      </header>

      <div className="qr-preview-control">
        <button className="qr-preview-trigger" onClick={() => setPreviewOpen(!previewOpen)}><span>✦</span> Preview: {demos.find(item => item.id === demo)?.label}</button>
        {previewOpen && <div className="qr-preview-popover"><span>SWITCH RESULT STATE</span>{demos.map(item => <button key={item.id} onClick={() => { setDemo(item.id); setShowEvidence(false); setEditing(false); setPreviewOpen(false) }} className={demo === item.id ? 'active' : ''}><i>{demo === item.id ? '✓' : ''}</i>{item.label}</button>)}</div>}
      </div>

      <main className={`qr-stage ${mobile ? 'qr-mobile-stage' : ''}`}>
        <section className="qr-question-area">
          <span className="qr-kicker">QUESTION 01</span>
          <h1>How do early-stage AI startups find their first ten paying customers?</h1>
          <div className="qr-answer-shell">
            <span className="qr-kicker">ANSWER</span>
            {running ? (
              <div className="qr-skeleton"><i /><i /><i /><i /></div>
            ) : passed || weak ? (
              <p>Early-stage teams most often find their first customers through founder-led conversations in communities where the problem is already discussed. The strongest pattern is to contribute useful context before introducing the product.</p>
            ) : (
              <div className="qr-held-answer"><span>◌</span><p>The answer is held back until there is enough evidence to support it.</p></div>
            )}
          </div>
        </section>

        <aside className="qr-panel">
          <div className="qr-panel-title"><div><span>QUESTION RUN</span><h2>How it checks itself</h2></div><span className={`qr-live-dot ${running ? 'active' : passed ? 'done' : ''}`} /></div>

          <div className={`qr-verdict ${passed ? 'success' : running ? 'progress' : 'caution'}`}>
            <div className="qr-verdict-icon">{passed ? '✓' : running ? '•••' : '!'}</div>
            <div><span>{passed ? 'ANSWER READY' : running ? 'CHECKING' : 'HONEST RESULT'}</span><h3>{title}</h3><p>{description}</p></div>
          </div>

          {!running && <Meter value={value} target={60} />}

          {running ? (
            <div className="qr-running-steps">
              <PassedGroup count={3} />
              <div className="qr-active-step"><span className="qr-spinner"/><div><strong>Scoring evidence</strong><p>Checking 4 threads across 2 communities…</p></div></div>
              <div className="qr-waiting-step"><span>05–07</span><p>Waiting for evidence score</p></div>
            </div>
          ) : passed ? (
            <div className="qr-running-steps"><PassedGroup count={7} /></div>
          ) : (
            <div className="qr-running-steps">
              <PassedGroup count={zero ? 1 : 4} />
              <WeakStep number="04" title="Score evidence" reason={zero ? '0 of 3 threads found.' : `${threads} of 3 threads found · score ${value} of 60.`} detail={zero ? 'This passes when at least 3 relevant, verified Reddit threads are found.' : `Found ${threads} verified thread. This check needs 3 or more relevant threads and a score of 60.`} open={openStep === '04'} onToggle={() => setOpenStep(openStep === '04' ? '' : '04')} />
              <WeakStep number="06" title="Map claims" reason={weak ? '2 claims have support; 1 still needs proof.' : 'No thread backs an answer yet, so we won’t guess.'} detail="This passes when every factual claim in the draft points to at least one verified source." open={openStep === '06'} onToggle={() => setOpenStep(openStep === '06' ? '' : '06')} />
              <WeakStep number="07" title="Correct and check" reason={weak ? 'Answer shown with medium confidence.' : 'Answer held back: not enough Reddit proof.'} detail="GoHook holds back low-confidence answers rather than presenting an unsupported conclusion." open={openStep === '07'} onToggle={() => setOpenStep(openStep === '07' ? '' : '07')} />
            </div>
          )}

          {!running && !passed && (
            <div className="qr-actions">
              <button className="qr-primary" onClick={() => setShowEvidence(!showEvidence)}>{showEvidence ? 'Hide what we found' : `Show what we found${threads ? ` (${threads})` : ''}`}</button>
              <button className="qr-secondary" onClick={() => setEditing(!editing)}>Rephrase question</button>
            </div>
          )}

          {editing && <div className="qr-rephrase"><label>Try a broader question</label><textarea defaultValue="How do early-stage startups find their first paying customers?"/><button>Use this question →</button></div>}
          {showEvidence && <div className="qr-evidence"><div><span>WHAT WE FOUND</span><small>{threads} verified</small></div>{threads ? evidence.slice(0, threads).map((item, index) => <a href="#" key={item}><span>S{index + 1}</span><p>{item}</p><b>↗</b></a>) : <p className="qr-empty-copy">No verified threads to show. Try broader words.</p>}</div>}

          {passed && <div className="qr-source-link"><span>✓</span><p>7 claims mapped to 6 sources</p><button>View proof</button></div>}
        </aside>
      </main>
    </div>
  )
}
