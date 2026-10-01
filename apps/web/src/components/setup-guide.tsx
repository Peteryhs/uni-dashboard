import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchCredentialsStatus, fetchHealth, triggerPoll, updateCredentials } from '@/lib/api';
import { dashboardOrigin, normalizeFeedAddress, oauthSetupCommand, readGuideProgress, saveGuideProgress, SETUP_STEPS } from '@/lib/setup-guide';
import './setup-guide.css';

const LEARN_HELP = 'https://uwaterloo.atlassian.net/wiki/plugins/viewsource/viewpagesrc.action?pageId=1544061525';
const GOOGLE_HELP = 'https://support.google.com/calendar/answer/37648?hl=en';
const CF_HELP = 'https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/';
type SettingsTab = 'taste' | 'schedule' | 'courses' | 'credentials';

function HelpLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

export function SetupGuide({ onExit, onSettings, initialStep }: { onExit: () => void; onSettings: (tab: SettingsTab) => void; initialStep?: number }) {
  const [step, setStep] = useState(() => initialStep ?? readGuideProgress().step);
  const [provider, setProvider] = useState<'portal' | 'google'>('portal');
  // Feed URLs can contain private tokens. Keep them only in memory until the user saves.
  const [feed, setFeed] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [address, setAddress] = useState(window.location.protocol === 'https:' ? window.location.origin : '');
  const [weeks, setWeeks] = useState(3);
  const [owner, setOwner] = useState(false);
  const [copied, setCopied] = useState('');
  const [syncing, setSyncing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['setup-credentials'], queryFn: ({ signal }) => fetchCredentialsStatus(signal), retry: false });
  const health = useQuery({ queryKey: ['health'], queryFn: ({ signal }) => fetchHealth(signal), retry: false, enabled: step === 4 });
  const origin = dashboardOrigin(address);
  const command = origin ? oauthSetupCommand(origin, weeks) : null;
  const configured = step === 0 ? status.data?.portal.configured : status.data?.learn.configured;

  useEffect(() => {
    saveGuideProgress(step);
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  function go(next: number) {
    setFeed(''); setFeedback(null); setCopied(''); setStep(next);
  }

  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setCopied(label); }
    catch { setCopied('Copy unavailable. Select the text above and copy it.'); }
  }

  async function saveFeed(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setFeedback(null);
    try {
      const url = normalizeFeedAddress(feed);
      // Both runtimes accept these keys; assigning the same schedule avoids a stale Google
      // override when replacing a previous feed with a Portal subscription.
      await updateCredentials(step === 0 ? { PORTAL_ICS_URL: url, GOOGLE_CALENDAR_ICS_URL: url } : { LEARN_ICS_URL: url });
      setFeed('');
      setFeedback({ error: false, text: 'Feed saved. Check source results in Review; saving alone does not confirm the feed can be read.' });
      await queryClient.invalidateQueries({ queryKey: ['setup-credentials'] });
      try {
        await triggerPoll();
        await Promise.all(['health', 'dashboard', 'full-calendar', 'recommendations'].map(key => queryClient.invalidateQueries({ queryKey: [key] })));
      } catch {
        setFeedback({ error: false, text: 'Feed saved. Sync could not start yet; retry from Review when the dashboard is reachable.' });
      }
    } catch (cause) {
      setFeedback({ error: true, text: cause instanceof Error ? cause.message : 'Could not save the feed. Try again.' });
    } finally { setSaving(false); }
  }

  async function sync() {
    setSyncing(true); setFeedback(null);
    try {
      await triggerPoll();
      await Promise.all([status.refetch(), health.refetch(), ...['dashboard', 'full-calendar', 'recommendations'].map(key => queryClient.invalidateQueries({ queryKey: [key] }))]);
      setFeedback({ error: false, text: 'Sync requested. Source results below show the latest reported runs.' });
    } catch (cause) { setFeedback({ error: true, text: cause instanceof Error ? cause.message : 'Could not sync. Try again when connected.' }); }
    finally { setSyncing(false); }
  }

  return <section className="setup-guide" aria-label="Dashboard setup guide">
    <div className="guide-toolbar">
      <p>Setup guide</p>
      <Button variant="ghost" onClick={onExit} disabled={saving || syncing}>Pause guide</Button>
    </div>
    <nav aria-label="Setup steps" className="guide-steps">
      {SETUP_STEPS.map((name, index) => <button key={name} type="button" disabled={saving || syncing} aria-current={index === step ? 'step' : undefined} onClick={() => go(index)}>
        <span>{index + 1}</span><span>{name}</span>
      </button>)}
    </nav>
    <div className="guide-body" key={step}>
      <p className="guide-position">Step {step + 1} of {SETUP_STEPS.length}{step < 2 ? ' · Needed for this feature' : ' · Optional'}</p>
      <h2 ref={heading} tabIndex={-1}>{['Bring in your timetable', 'Bring in your deadlines', 'Make the dashboard yours', 'Take your dashboard with you', 'Check your connections'][step]}</h2>

      {step === 0 && <>
        <p>Choose one subscription feed for classes and personal events. Use a live iCal link, rather than a downloaded calendar file.</p>
        <fieldset className="guide-provider"><legend>Schedule provider</legend>
          {(['portal', 'google'] as const).map(value => <label key={value}><input type="radio" name="schedule-provider" value={value} checked={provider === value} disabled={saving} onChange={() => { setProvider(value); setFeed(''); setFeedback(null); }} />{value === 'portal' ? 'Waterloo Portal' : 'Google Calendar'}</label>)}
        </fieldset>
        {provider === 'portal' ? <>
          <ol className="guide-instructions">
            <li><HelpLink href="https://portal.uwaterloo.ca/">Open Waterloo Portal</HelpLink> and sign in with your university account.</li>
            <li>Open Calendar and look for its export or calendar subscription option. Portal’s menu labels can change.</li>
            <li>Copy the iCal subscription address for the calendar containing your classes, then paste it below.</li>
          </ol>
          <p className="guide-note">Can’t find a subscription link? Use a Google calendar that already contains your timetable. This dashboard cannot read a Portal sign-in page or import an .ics file upload.</p>
        </> : <>
          <ol className="guide-instructions">
            <li><HelpLink href="https://calendar.google.com/">Open Google Calendar</HelpLink> on the web. Open Settings and choose your calendar under Settings for my calendars.</li>
            <li>Open Integrate calendar, then find the private iCal subscription address.</li>
            <li>Copy that address and paste it below. It only includes events from the calendar you selected.</li>
          </ol>
          <p className="guide-note">If your school account hides this address, ask its administrator or use Portal. Don’t make your calendar public to connect it. <HelpLink href={GOOGLE_HELP}>Google’s instructions</HelpLink></p>
        </>}
      </>}

      {step === 1 && <>
        <p>LEARN’s calendar feed brings in deadlines published by your instructors. It does not include every assignment automatically.</p>
        <ol className="guide-instructions">
          <li><HelpLink href="https://learn.uwaterloo.ca/">Open Waterloo LEARN</HelpLink> and open Calendar from the homepage or a course.</li>
          <li>Open the calendar’s Settings, enable calendar feeds, and save.</li>
          <li>Open Subscribe. Choose the option containing all calendars and tasks to include your courses.</li>
          <li>Copy the subscription URL and paste it below.</li>
        </ol>
        <p className="guide-note">Keep checking course pages for deadlines instructors haven’t added to the calendar. <HelpLink href={LEARN_HELP}>Waterloo’s instructions</HelpLink></p>
      </>}

      {step < 2 && <form onSubmit={saveFeed} className="guide-feed-form">
        <Label htmlFor="guide-feed">{step === 0 ? 'Schedule subscription URL' : 'LEARN subscription URL'}</Label>
        <Input id="guide-feed" type="password" autoComplete="off" spellCheck={false} value={feed} disabled={saving} onChange={e => setFeed(e.target.value)} placeholder="https://… or webcal://…" aria-describedby="guide-feed-note" />
        <p id="guide-feed-note" className="guide-note">These links can give access to your calendar. They are saved to your dashboard, shared by its authorized users; guide progress never stores them.</p>
        <div className="guide-save-row"><Button type="submit" disabled={saving || !feed.trim()}>{saving ? 'Saving feed…' : 'Save feed'}</Button><span>{status.isPending ? 'Checking saved settings…' : status.isError ? 'Saved status unavailable' : configured ? 'A feed is already configured' : 'No feed configured yet'}</span></div>
      </form>}

      {step === 2 && <>
        <p>These settings are optional. They refine the information you see; your calendar feeds work without them.</p>
        <div className="guide-settings-links">
          <Button variant="outline" onClick={() => onSettings('taste')}>Set dining preferences</Button><p>Choose dietary needs, likes, and dislikes. Your dining profile syncs to the dashboard; favorites stay in this browser.</p>
          <Button variant="outline" onClick={() => onSettings('courses')}>Review your courses</Button><p>Choose a lab section and group where applicable. Add course resources and check any syllabus extracts before saving them.</p>
          <Button variant="outline" onClick={() => onSettings('schedule')}>Add office hours</Button><p>Add recurring office hours or help sessions and review their dates and locations.</p>
        </div>
        <details className="guide-details"><summary>Optional Workers AI connection</summary>
          <p>{status.data?.cloudflare?.configured ? 'Workers AI is configured. No extra AI credentials are needed for this guide.' : 'On a Cloudflare deployment, the owner can enable the native Workers AI binding. Local deployments can use an account ID and a token with Workers AI permissions in Connections.'}</p>
          <p>These are AI credentials. Mobile browser sign-in uses a separate Cloudflare Access configuration and does not require pasting an API token into your phone.</p>
          {!status.data?.cloudflare?.configured && <ol className="guide-instructions">
            <li>In the Cloudflare dashboard, open Workers AI and its REST API setup.</li>
            <li>Create a token from the Workers AI template and copy it. For a custom token, include Workers AI Read and Edit permissions for your account.</li>
            <li>Copy the account ID shown there. Open Connections below and paste both values into Workers AI Connection, then save.</li>
          </ol>}
          <HelpLink href="https://developers.cloudflare.com/workers-ai/get-started/rest-api/">Cloudflare’s Workers AI instructions</HelpLink>
          <Button variant="outline" onClick={() => onSettings('credentials')}>Open Connections</Button>
        </details>
      </>}

      {step === 3 && <>
        <p>The Android app connects to this same dashboard. Your feeds and server settings do not need to be entered again on the phone.</p>
        <Label htmlFor="guide-dashboard">Dashboard address</Label>
        <Input id="guide-dashboard" type="text" inputMode="url" autoComplete="url" spellCheck={false} value={address} onChange={e => { setAddress(e.target.value); setCopied(''); }} placeholder="https://dash.example.com" />
        {address && !origin && <p role="alert" className="guide-error">Enter a valid HTTPS dashboard address.</p>}
        {origin && <div className="guide-copy"><code>{origin}</code><Button variant="outline" onClick={() => void copy(origin, 'Dashboard address copied')}>Copy address</Button></div>}
        <ol className="guide-instructions">
          <li>Install the Android app. Paste this address into Dashboard address.</li>
          <li>Tap Sign in. Complete Cloudflare Access sign-in in your system browser, then allow the return to UniDash.</li>
          <li>Once connected, check your schedule. In the app’s Settings, turn on reminders if you want them.</li>
        </ol>
        <p className="guide-note">No Client ID or secret is needed for browser sign-in. If sign-in discovery fails, the dashboard owner needs to enable Managed OAuth below. Browser cookies have a separate session duration.</p>
        <Button variant="outline" aria-expanded={owner} onClick={() => setOwner(!owner)}>{owner ? 'Hide owner setup' : 'I manage this Cloudflare dashboard'}</Button>
        {owner && <section className="guide-owner" aria-label="Cloudflare owner setup">
          <h3>Enable mobile browser sign-in</h3>
          <p>Deploy the updated dashboard Worker, including its Android callback route, before testing the matching Android app. The Access setup tool only changes the Access application.</p>
          <p>In Cloudflare Zero Trust, open the Access application protecting the entire dashboard hostname. In Advanced settings, enable Managed OAuth and dynamic client registration. Add the exact redirect below, preserving existing redirect addresses and Access policies.</p>
          {origin && <div className="guide-copy"><code>{origin}/oauth/android/callback</code><Button variant="outline" onClick={() => void copy(`${origin}/oauth/android/callback`, 'Redirect address copied')}>Copy redirect</Button></div>}
          <Label htmlFor="guide-weeks">Refresh session duration</Label>
          <select id="guide-weeks" value={weeks} onChange={e => { setWeeks(Number(e.target.value)); setCopied(''); }}>
            <option value={1}>1 week (168 hours)</option><option value={2}>2 weeks (336 hours)</option><option value={3}>3 weeks (504 hours)</option>
          </select>
          <p>Request <strong>{weeks} {weeks === 1 ? 'week' : 'weeks'}</strong> for Grant session duration and keep Access token lifetime at 15 minutes. Cloudflare’s recommendation is 1–2 weeks; 3 weeks requests a longer grant. Policies or revocation may end access sooner.</p>
          <p className="guide-note">Choosing here prepares the owner setup; it does not change Cloudflare. Save the duration in Cloudflare, or use the repository tool below. Cloudflare must accept the configuration. Sign in again on the phone to start a new grant.</p>
          <details className="guide-details"><summary>Use the repository setup tool instead</summary>
            <p>From the repository folder, set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in your terminal environment. The token needs Access: Apps and Policies Write for your account. Keep it out of the phone and the AI connection fields.</p>
            {command ? <><div className="guide-copy"><code>{command}</code><Button variant="outline" onClick={() => void copy(command, 'Preview command copied')}>Copy preview command</Button></div><p>Run the command to inspect the proposed change. After reviewing it, run it again with <code> --apply</code>. Add <code> --app-id YOUR_APP_ID</code> if your application can’t be discovered from ACCESS_AUD.</p></> : <p>Enter the public HTTPS dashboard address to generate the command.</p>}
          </details>
          <HelpLink href={CF_HELP}>Cloudflare’s Managed OAuth instructions</HelpLink>
        </section>}
        {copied && <p role="status" className="guide-note">{copied}</p>}
      </>}

      {step === 4 && <>
        <p>You can finish the guide with steps still outstanding. The checks below report actual saved settings and source runs.</p>
        {status.isError ? <div className="guide-note"><p role="alert">Could not read connection settings. Check your dashboard connection or sign in again.</p><Button variant="outline" onClick={() => void status.refetch()}>Retry connection check</Button></div> : <dl className="guide-review">
          <div><dt>Schedule feed</dt><dd>{status.isPending ? 'Checking…' : status.data?.portal.configured ? 'Configured' : 'Not configured'}</dd></div>
          <div><dt>LEARN feed</dt><dd>{status.isPending ? 'Checking…' : status.data?.learn.configured ? 'Configured' : 'Not configured'}</dd></div>
          <div><dt>Workers AI (optional)</dt><dd>{status.isPending ? 'Checking…' : status.data?.cloudflare?.configured ? 'Configured' : 'Not configured'}</dd></div>
        </dl>}
        <Button variant="outline" onClick={() => void sync()} disabled={syncing}>{syncing ? 'Requesting sync…' : 'Sync and check sources'}</Button>
        {health.isError && <p role="alert" className="guide-error">Source results unavailable. Retry the sync when the dashboard is reachable.</p>}
        {health.isPending && <p className="guide-note">Reading source results…</p>}
        {health.data && <details className="guide-details" open><summary>Latest source results</summary><dl className="guide-review">{health.data.sources.filter(source => source.needs_secret).map(source => <div key={source.id}><dt>{source.id}</dt><dd>{!source.ready ? 'Needs configuration' : source.last_run ? `${source.last_run.outcome} · ${source.last_run.rows} rows` : 'Configured; no run reported'}</dd></div>)}</dl><p className="guide-note">A configured feed can still fail to load or contain no events. Use Connections for full source health and errors.</p></details>}
        <Button variant="outline" onClick={() => onSettings('credentials')}>Open Connections</Button>
        <p className="guide-note">Reopen this guide with Setup guide in Settings. Mobile setup instructions do not verify that a phone is connected.</p>
      </>}
      {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'guide-error' : 'guide-feedback'}>{feedback.text}</p>}
    </div>
    <div className="guide-navigation">
      <Button variant="outline" disabled={step === 0 || saving || syncing} onClick={() => go(step - 1)}>Back</Button>
      {step < SETUP_STEPS.length - 1 ? <Button disabled={saving || syncing} onClick={() => go(step + 1)}>{step < 2 && !configured ? 'Skip for now' : 'Continue'}</Button> : <Button disabled={syncing} onClick={() => { saveGuideProgress(step, true); onExit(); }}>Finish guide</Button>}
    </div>
  </section>;
}
