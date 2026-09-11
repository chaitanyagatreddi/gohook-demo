import { useState, type MouseEvent } from 'react'
import { motion, AnimatePresence, type PanInfo } from 'motion/react'
import { supabase } from './supabaseClient'

type StepKind = 'signin' | 'zernio'

type Step = {
    id: number
    kind: StepKind
    title: string
    colors: { from: string; to: string; light: string; text: string }
}

const STEPS: Step[] = [
    {
        id: 1,
        kind: 'signin',
        title: 'Sign in',
        colors: { from: '#ff4500', to: '#ffffff', light: '#7a2b00', text: '#1a1a1a' },
    },
    {
        id: 2,
        kind: 'zernio',
        title: 'Connect Zernio',
        colors: { from: '#1a1a1a', to: '#9ca3af', light: '#e5e7eb', text: '#ffffff' },
    },
]

const SWIPE_THRESHOLD = 120

type OnboardingDeckProps = {
    authEmail: string
    setAuthEmail: (v: string) => void
    authSent: boolean
    authError: string
    sendMagicLink: () => void
    session: boolean
    zernioKeyInput: string
    setZernioKeyInput: (v: string) => void
    zernioConnecting: boolean
    zernioError: string
    zernioConnected: boolean
    connectZernio: () => void
    onDone: () => void
    signInOnly?: boolean
}

const OnboardingDeck = ({
    authEmail,
    setAuthEmail,
    authSent,
    authError,
    sendMagicLink,
    session,
    zernioKeyInput,
    setZernioKeyInput,
    zernioConnecting,
    zernioError,
    zernioConnected,
    connectZernio,
    onDone,
    signInOnly = false,
}: OnboardingDeckProps) => {
    const steps = signInOnly ? STEPS.filter((s) => s.kind === 'signin') : STEPS
    const [currentStep, setCurrentStep] = useState(0)
    const [exitDir, setExitDir] = useState(1)
    const [completed, setCompleted] = useState(false)

    const step = steps[currentStep]
    const nextStep = steps[currentStep + 1]
    const isLast = currentStep >= steps.length - 1

    const advance = (dir = 1) => {
        setExitDir(dir)
        if (isLast) {
            setCompleted(true)
            return
        }
        setCurrentStep((prev) => prev + 1)
    }

    const goBack = () => {
        if (completed) {
            setCompleted(false)
            setCurrentStep(steps.length - 1)
            return
        }
        if (currentStep === 0) return
        setExitDir(-1)
        setCurrentStep((prev) => prev - 1)
    }

    const onDragEnd = (_: unknown, info: PanInfo) => {
        if (Math.abs(info.offset.x) > SWIPE_THRESHOLD || Math.abs(info.velocity.x) > 600) {
            advance(info.offset.x > 0 ? 1 : -1)
        }
    }

    const handleSignInClick = (e?: MouseEvent) => {
        e?.stopPropagation()
        sendMagicLink()
    }

    const handleZernioClick = (e?: MouseEvent) => {
        e?.stopPropagation()
        connectZernio()
    }

    const [oauthPending, setOauthPending] = useState<'google' | null>(null)

    const handleOAuthClick = (provider: 'google') => async (e?: MouseEvent) => {
        e?.stopPropagation()
        setOauthPending(provider)
        await supabase.auth.signInWithOAuth({ provider })
    }

    // Auto-advance once each step's action succeeds
    if (step.kind === 'signin' && authSent && currentStep === 0) {
        setTimeout(() => advance(1), 600)
    }
    if (step.kind === 'zernio' && zernioConnected && currentStep === 1 && !completed) {
        setTimeout(() => advance(1), 600)
    }

    return (
        <div className="flex flex-col w-full justify-center items-center overflow-hidden gap-8 px-4 py-10">
            <div className="relative w-full max-w-[400px] h-[440px]" style={{ perspective: 1400 }}>
                <AnimatePresence mode="wait">
                    {completed ? (
                        <motion.div
                            key="done"
                            initial={{ opacity: 0, scale: 0.9, y: 24 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            transition={{ type: 'spring', stiffness: 260, damping: 22 }}
                            className="absolute inset-0 rounded-2xl bg-[#14171c] shadow-2xl border border-[#242a33] flex flex-col items-center justify-center text-center p-10"
                        >
                            <h2 className="text-2xl font-bold text-[#e8eaed] mb-6">You're in</h2>

                            <div className="flex flex-col gap-3 w-full max-w-[280px] mb-4">
                                <motion.div
                                    initial={{ opacity: 0, y: 12, scale: 0.95 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    transition={{ type: 'spring', stiffness: 280, damping: 20 }}
                                    className="flex items-center gap-3 rounded-[8px] border border-[#242a33] bg-[#0b0d10] px-4 py-3 text-left"
                                >
                                    <span className="text-3xl" aria-hidden>✓</span>
                                    <div>
                                        <p className="text-[14px] font-semibold text-[#e8eaed]">Signed in</p>
                                        <p className="text-[12px] text-[#9aa4b2]">Magic link confirmed</p>
                                    </div>
                                </motion.div>
                                {!signInOnly && (
                                    <motion.div
                                        initial={{ opacity: 0, y: 12, scale: 0.95 }}
                                        animate={{ opacity: 1, y: 0, scale: 1 }}
                                        transition={{ type: 'spring', stiffness: 280, damping: 20, delay: 0.12 }}
                                        className="flex items-center gap-3 rounded-[8px] border border-[#242a33] bg-[#0b0d10] px-4 py-3 text-left"
                                    >
                                        <span className="text-3xl" aria-hidden>⚡</span>
                                        <div>
                                            <p className="text-[14px] font-semibold text-[#e8eaed]">Zernio connected</p>
                                            <p className="text-[12px] text-[#9aa4b2]">Ready to schedule to Reddit</p>
                                        </div>
                                    </motion.div>
                                )}
                            </div>

                            <p className="text-[#9aa4b2] text-sm max-w-[260px]">
                                {signInOnly
                                    ? 'You can keep scanning Reddit — sign in unlocked unlimited searches.'
                                    : 'Redditscan can now schedule and post on your behalf.'}
                            </p>
                            <button
                                type="button"
                                onClick={onDone}
                                className="mt-8 px-5 py-2.5 rounded-lg text-white text-sm font-semibold shadow-sm bg-[#ff4500] hover:bg-[#ff6a33] transition-colors"
                            >
                                Continue
                            </button>
                        </motion.div>
                    ) : (
                        <>
                            {nextStep && (
                                <div
                                    className="absolute inset-0 rounded-2xl scale-[0.96] translate-y-3 opacity-90 pointer-events-none"
                                    style={{
                                        background: `linear-gradient(135deg, ${nextStep.colors.from}, ${nextStep.colors.to})`,
                                        zIndex: 0,
                                    }}
                                    aria-hidden
                                />
                            )}

                            <motion.div
                                key={step.id}
                                className="absolute inset-0 z-10"
                                initial={{ opacity: 0, x: exitDir > 0 ? 56 : -56, rotate: exitDir > 0 ? 4 : -4 }}
                                animate={{ opacity: 1, x: 0, rotate: 0 }}
                                exit={{
                                    opacity: 0,
                                    x: exitDir > 0 ? 280 : -280,
                                    rotate: exitDir > 0 ? 18 : -18,
                                    transition: { duration: 0.35 },
                                }}
                                transition={{ type: 'spring', stiffness: 280, damping: 24 }}
                                drag="x"
                                dragConstraints={{ left: 0, right: 0 }}
                                dragElastic={0.85}
                                dragMomentum={false}
                                onDragEnd={onDragEnd}
                            >
                                <div
                                    className="absolute inset-0 w-full h-full rounded-2xl shadow-2xl flex flex-col items-center justify-between p-8 text-center"
                                    style={{
                                        background: `linear-gradient(135deg, ${step.colors.from}, ${step.colors.to})`,
                                        boxShadow: `0 25px 50px -12px ${step.colors.from}66`,
                                        color: step.colors.text,
                                    }}
                                >
                                    <div className="flex flex-col items-center pt-10">
                                        <div
                                            className="w-14 h-14 rounded-full flex items-center justify-center mb-6 shadow-inner"
                                            style={{ background: `${step.colors.text}22` }}
                                        >
                                            <span className="text-2xl font-bold">{step.id}</span>
                                        </div>
                                        <h2 className="text-3xl font-bold tracking-tight">{step.title}</h2>
                                    </div>

                                    <div className="w-full pb-2">
                                        {step.kind === 'signin' ? (
                                            <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
                                                <input
                                                    type="email"
                                                    value={authEmail}
                                                    onChange={(e) => setAuthEmail(e.target.value)}
                                                    placeholder="you@email.com"
                                                    className="w-full rounded-lg px-4 py-2.5 text-sm text-gray-800 bg-white/90 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-white/60"
                                                />
                                                <motion.button
                                                    type="button"
                                                    whileTap={{ scale: 0.98 }}
                                                    whileHover={{ y: -1 }}
                                                    onClick={handleSignInClick}
                                                    disabled={authSent || session}
                                                    className="w-full flex items-center justify-center gap-2 bg-white text-gray-800 font-medium text-[15px] py-3 px-4 rounded-lg shadow-md border border-gray-200 hover:bg-gray-50 transition disabled:opacity-60"
                                                >
                                                    {session ? 'Signed in ✓' : authSent ? 'Check your email ✓' : 'Sign in with email'}
                                                </motion.button>
                                                {authError && <p className="text-xs text-red-900 bg-white/70 rounded px-2 py-1">{authError}</p>}

                                                <div className="flex items-center gap-2 my-1">
                                                    <div className="flex-1 h-px bg-white/30" />
                                                    <span className="text-[10px] uppercase tracking-wide" style={{ color: step.colors.light }}>or</span>
                                                    <div className="flex-1 h-px bg-white/30" />
                                                </div>

                                                <motion.button
                                                    type="button"
                                                    whileTap={{ scale: 0.96 }}
                                                    whileHover={{ y: -1 }}
                                                    onClick={handleOAuthClick('google')}
                                                    disabled={oauthPending !== null}
                                                    className="w-full flex items-center justify-center gap-2 bg-white text-gray-800 font-medium text-[15px] py-3 px-4 rounded-lg shadow-md border border-gray-200 hover:bg-gray-50 transition disabled:opacity-60"
                                                >
                                                    {oauthPending === 'google' ? (
                                                        <motion.span
                                                            className="w-4 h-4 rounded-full border-2 border-gray-300 border-t-gray-700"
                                                            animate={{ rotate: 360 }}
                                                            transition={{ repeat: Infinity, duration: 0.6, ease: 'linear' }}
                                                        />
                                                    ) : (
                                                        'Continue with Google'
                                                    )}
                                                </motion.button>
                                            </div>
                                        ) : (
                                            <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
                                                <input
                                                    type="text"
                                                    value={zernioKeyInput}
                                                    onChange={(e) => setZernioKeyInput(e.target.value)}
                                                    placeholder="Paste your Zernio API key"
                                                    className="w-full rounded-lg px-4 py-2.5 text-sm text-gray-100 bg-black/40 border border-white/20 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-white/40"
                                                />
                                                <motion.button
                                                    type="button"
                                                    whileTap={{ scale: 0.98 }}
                                                    whileHover={{ y: -1 }}
                                                    onClick={handleZernioClick}
                                                    disabled={zernioConnecting || zernioConnected}
                                                    className="w-full flex items-center justify-center gap-2 font-medium text-[15px] py-3 px-4 rounded-lg shadow-md border transition hover:opacity-95 disabled:opacity-60"
                                                    style={{ backgroundColor: '#ffffff', color: '#1a1a1a', borderColor: 'rgba(255,255,255,0.3)' }}
                                                >
                                                    {zernioConnected ? 'Connected ✓' : zernioConnecting ? 'Connecting…' : 'Connect Zernio'}
                                                </motion.button>
                                                <a
                                                    href="https://zernio.com/signup"
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-xs underline opacity-80 hover:opacity-100"
                                                >
                                                    Don't have a Zernio key? Get one →
                                                </a>
                                                {zernioError && <p className="text-xs text-red-200 bg-black/40 rounded px-2 py-1">{zernioError}</p>}
                                            </div>
                                        )}
                                        <p className="mt-4 text-xs tracking-wide uppercase" style={{ color: step.colors.light }}>
                                            Or swipe for next
                                        </p>
                                    </div>
                                </div>
                            </motion.div>
                        </>
                    )}
                </AnimatePresence>
            </div>

            {!completed && steps.length > 1 && (
                <div className="flex items-center gap-4">
                    <button
                        type="button"
                        onClick={goBack}
                        disabled={currentStep === 0}
                        className="w-10 h-10 rounded-lg border border-[#242a33] bg-[#14171c] flex items-center justify-center text-[#9aa4b2] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#1c2027]"
                        aria-label="Previous"
                    >
                        ←
                    </button>

                    <div className="flex items-center gap-2">
                        {steps.map((s, i) => (
                            <div
                                key={s.id}
                                className="h-1.5 rounded-full transition-all"
                                style={{
                                    width: i === currentStep ? 28 : 8,
                                    backgroundColor:
                                        i === currentStep ? step.colors.from : i < currentStep ? '#ff4500' : '#242a33',
                                }}
                            />
                        ))}
                    </div>

                    <button
                        type="button"
                        onClick={() => advance(1)}
                        className="w-10 h-10 rounded-lg border border-[#242a33] bg-[#14171c] flex items-center justify-center text-[#9aa4b2] hover:bg-[#1c2027]"
                        aria-label="Next"
                    >
                        →
                    </button>
                </div>
            )}
        </div>
    )
}

export default OnboardingDeck
