import { useState } from 'react'
import { supabase } from './supabaseClient'

type SignInCardProps = {
    authEmail: string
    setAuthEmail: (v: string) => void
    authSent: boolean
    authError: string
    sendMagicLink: () => void
    session: boolean
    onDone: () => void
}

/** The signed-out screen: sign in with an email link or with Google. */
const OnboardingDeck = ({ authEmail, setAuthEmail, authSent, authError, sendMagicLink, session, onDone }: SignInCardProps) => {
    const [oauthPending, setOauthPending] = useState(false)

    async function signInWithGoogle() {
        setOauthPending(true)
        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin },
        })
        if (error) setOauthPending(false)
    }

    return (
        <div className="w-full max-w-md mx-auto py-10">
            <div className="rounded-2xl border border-[#2a2d33] bg-[#121417] p-7 sm:p-8 shadow-[0_24px_80px_rgba(0,0,0,0.3)]">
                <div className="w-11 h-11 rounded-xl bg-[#17191e] border border-[#2a2d33] grid place-items-center mb-6">
                    <svg viewBox="0 0 24 24" fill="none" stroke="#ff6a33" strokeWidth="1.6" className="w-5 h-5" aria-hidden="true">
                        <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="7" r="2.5" /><circle cx="12" cy="17" r="2.5" />
                        <path d="M8 7.5l8 -0.5M7.2 8.2L11 14.8M16.8 9.2L13 14.8" />
                    </svg>
                </div>
                <h2 className="text-2xl font-semibold tracking-[-0.03em] text-[#f1f2f4]">Your graph is yours alone</h2>
                <p className="mt-2 text-sm leading-relaxed text-[#9aa4b2]">
                    Sign in to keep your questions, saved threads, and connections together.
                </p>

                {authSent ? (
                    <div className="mt-6 rounded-xl border border-[#2a2d33] bg-[#0d0f12] px-4 py-3.5">
                        <p className="text-sm font-medium text-[#e8eaed]">Check your email</p>
                        <p className="mt-1 text-xs leading-relaxed text-[#9aa4b2]">We sent a sign-in link to {authEmail}.</p>
                    </div>
                ) : (
                    <form className="mt-6" onSubmit={(event) => { event.preventDefault(); sendMagicLink() }}>
                        <label className="block text-xs font-medium text-[#c4c8cf] mb-2" htmlFor="sign-in-email">Email address</label>
                        <input
                            id="sign-in-email"
                            type="email"
                            value={authEmail}
                            onChange={(e) => setAuthEmail(e.target.value)}
                            placeholder="you@email.com"
                            className="w-full rounded-lg border border-[#2a2d33] bg-[#0d0f12] px-3.5 py-3 text-sm text-[#f1f2f4] placeholder:text-[#6b7280] focus:outline-none focus:border-[#ff6a33]"
                        />
                        <button
                            type="submit"
                            disabled={session || !authEmail.trim()}
                            className="mt-3 w-full rounded-lg bg-[#ff4500] hover:bg-[#ff6a33] py-3 text-sm font-medium text-white transition-colors disabled:opacity-50"
                        >
                            {session ? 'Signed in ✓' : 'Continue with email'}
                        </button>
                    </form>
                )}

                {!authSent && (
                    <>
                        <div className="flex items-center gap-3 my-5">
                            <div className="h-px flex-1 bg-[#2a2d33]" />
                            <span className="text-[11px] uppercase tracking-[0.08em] text-[#737984]">or</span>
                            <div className="h-px flex-1 bg-[#2a2d33]" />
                        </div>
                        <button
                            type="button"
                            onClick={signInWithGoogle}
                            disabled={oauthPending}
                            className="w-full rounded-lg border border-[#2a2d33] bg-[#191b1f] hover:bg-[#202328] py-3 text-sm font-medium text-[#f1f2f4] transition-colors disabled:opacity-50"
                        >
                            {oauthPending ? 'Opening Google…' : 'Continue with Google'}
                        </button>
                    </>
                )}

                {authError && <p className="mt-3 text-xs text-[#ff8a66]">{authError}</p>}
                {session && <button type="button" onClick={onDone} className="mt-5 text-sm text-[#ff6a33] hover:underline">Continue</button>}
            </div>
        </div>
    )
}

export default OnboardingDeck
