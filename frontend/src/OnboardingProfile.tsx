import { useState } from 'react'
import { supabase } from './supabaseClient'

type Props = {
  onDone: () => void
}

/** Shown once, right after first sign-in, before the app is usable. */
const OnboardingProfile = ({ onDone }: Props) => {
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [linkedin, setLinkedin] = useState('')
  const [role, setRole] = useState('')
  const [goal, setGoal] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    if (!name.trim() || !company.trim() || !linkedin.trim()) {
      setError('Name, company and LinkedIn are required to continue.')
      return
    }
    setSaving(true)
    setError('')
    const { data } = await supabase.auth.getUser()
    const userId = data.user?.id
    if (!userId) {
      setError('Something went wrong. Please try signing in again.')
      setSaving(false)
      return
    }
    const { error: dbError } = await supabase
      .from('profiles')
      .update({ full_name: name.trim(), company: company.trim(), linkedin_url: linkedin.trim(), role: role || null, goal: goal || null })
      .eq('id', userId)
    setSaving(false)
    if (dbError) {
      setError('Could not save your profile. Please try again.')
      return
    }
    onDone()
  }

  return (
    <div className="w-full max-w-md mx-auto py-10">
      <div className="rounded-2xl border border-[#242a33] bg-[#14171c] p-7 sm:p-8 shadow-[0_24px_80px_rgba(0,0,0,0.3)]">
        <h2 className="text-2xl font-semibold tracking-[-0.02em] text-[#e8eaed]">Tell us who you are</h2>
        <p className="mt-2 text-sm leading-relaxed text-[#9aa4b2]">
          Two fields. Everything else is optional &mdash; we&apos;d rather you get to your score than fill out a form.
        </p>

        <form className="mt-6 flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void save() }}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ob-name" className="text-xs font-medium text-[#e8eaed]">Name <span className="text-[#ff6a33]">*</span></label>
            <input
              id="ob-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Jordan Lee"
              className="rounded-lg border border-[#242a33] bg-[#0b0d10] px-3.5 py-3 text-sm text-[#e8eaed] placeholder:text-[#525862] focus:outline-none focus:border-[#ff6a33]"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="ob-company" className="text-xs font-medium text-[#e8eaed]">Company <span className="text-[#ff6a33]">*</span></label>
            <input
              id="ob-company"
              value={company}
              onChange={e => setCompany(e.target.value)}
              placeholder="Acme Inc."
              className="rounded-lg border border-[#242a33] bg-[#0b0d10] px-3.5 py-3 text-sm text-[#e8eaed] placeholder:text-[#525862] focus:outline-none focus:border-[#ff6a33]"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="ob-linkedin" className="text-xs font-medium text-[#e8eaed]">LinkedIn URL <span className="text-[#ff6a33]">*</span></label>
            <input
              id="ob-linkedin"
              value={linkedin}
              onChange={e => setLinkedin(e.target.value)}
              placeholder="https://www.linkedin.com/in/yourname"
              className="rounded-lg border border-[#242a33] bg-[#0b0d10] px-3.5 py-3 text-sm text-[#e8eaed] placeholder:text-[#525862] focus:outline-none focus:border-[#ff6a33]"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1 flex flex-col gap-1.5">
              <label htmlFor="ob-role" className="text-xs font-medium text-[#e8eaed]">Role <span className="text-[#6b7280] font-normal">optional</span></label>
              <select
                id="ob-role"
                value={role}
                onChange={e => setRole(e.target.value)}
                className="rounded-lg border border-[#242a33] bg-[#0b0d10] px-3.5 py-3 text-sm text-[#e8eaed] focus:outline-none focus:border-[#ff6a33]"
              >
                <option value="">Select&hellip;</option>
                <option value="founder">Founder</option>
                <option value="marketer">Marketer</option>
                <option value="agency">Agency / fractional</option>
              </select>
            </div>
            <div className="flex-1 flex flex-col gap-1.5">
              <label htmlFor="ob-goal" className="text-xs font-medium text-[#e8eaed]">Goal <span className="text-[#6b7280] font-normal">optional</span></label>
              <select
                id="ob-goal"
                value={goal}
                onChange={e => setGoal(e.target.value)}
                className="rounded-lg border border-[#242a33] bg-[#0b0d10] px-3.5 py-3 text-sm text-[#e8eaed] focus:outline-none focus:border-[#ff6a33]"
              >
                <option value="">Select&hellip;</option>
                <option value="grow_signups">Grow signups</option>
                <option value="track_mentions">Track brand mentions</option>
                <option value="find_leads">Find leads</option>
              </select>
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={saving}
            className="mt-1 w-full rounded-lg bg-[#ff4500] hover:bg-[#ff6a33] py-3 text-sm font-medium text-white transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Continue →'}
          </button>
          <p className="text-center text-[11px] text-[#525862]">Name, company and LinkedIn are required to continue.</p>
        </form>
      </div>
    </div>
  )
}

export default OnboardingProfile
