import { useEffect, useId, useState } from 'react';
import { AlertTriangle, BookOpen, Bot, CalendarDays, ExternalLink, LoaderCircle, Save } from 'lucide-react';
import {
  fetchCourseSyllabus,
  previewCourseSyllabus,
  saveCourseSyllabus,
} from '@/lib/api';
import type { CourseSyllabus, CourseSyllabusPreview } from '@/lib/contract';
import './course-syllabus-panel.css';

const campusDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
});
const campusTimeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto', hour: 'numeric', minute: '2-digit',
});
const ENTRY_LABEL: Record<string, string> = {
  topic: 'Topic', assessment: 'Assessment', reading: 'Reading',
};

function dateLabel(value: string): string {
  return campusDateFormat.format(new Date(`${value}T12:00:00Z`));
}

function entryDateLabel(entry: CourseSyllabus['entries'][number]): string {
  if (entry.due_at != null) {
    return `${dateLabel(entry.start_date)} · due ${campusTimeFormat.format(entry.due_at)}`;
  }
  if (entry.start_date === entry.end_date) return `${dateLabel(entry.start_date)} · time not supplied`;
  return `${dateLabel(entry.start_date)} – ${dateLabel(entry.end_date)}`;
}

function updatedLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short',
  }).format(timestamp);
}

function SyllabusWarnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return <div className="syllabus-warnings" role="note">
    <AlertTriangle aria-hidden="true" size={14} />
    <ul>{warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
  </div>;
}

function EntryList({ entries }: { entries: CourseSyllabus['entries'] }) {
  if (!entries.length) return <p className="syllabus-empty">No dated entries were found in this syllabus.</p>;
  return <ol className="syllabus-entry-list">
    {entries.map((entry) => <li key={entry.id} className="syllabus-entry">
      <div className="syllabus-entry-heading">
        <span className={`syllabus-entry-kind syllabus-entry-kind--${entry.kind}`}>{ENTRY_LABEL[entry.kind]}</span>
        <time dateTime={entry.due_at == null ? entry.start_date : new Date(entry.due_at).toISOString()}>{entryDateLabel(entry)}</time>
      </div>
      <strong>{entry.title}</strong>
      {entry.topics.length > 0 && <p><span>Topics</span> {entry.topics.join(', ')}</p>}
      {entry.readings.length > 0 && <p><span>Readings</span> {entry.readings.join(', ')}</p>}
      {entry.url && <a href={entry.url} target="_blank" rel="noopener noreferrer">Open source link <ExternalLink aria-hidden="true" size={12} /></a>}
      <details className="syllabus-evidence"><summary>Source text</summary><p>{entry.evidence}</p></details>
    </li>)}
  </ol>;
}

export function CourseSyllabusPanel({
  course,
  onSaved,
}: {
  course: string;
  onSaved?: (syllabus: CourseSyllabus) => void;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<CourseSyllabus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [text, setText] = useState('');
  const [termStart, setTermStart] = useState('');
  const [year, setYear] = useState('');
  const [preview, setPreview] = useState<CourseSyllabusPreview | null>(null);
  const [previewing, setPreviewing] = useState<'rules' | 'ai' | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    fetchCourseSyllabus(course, controller.signal)
      .then(setSaved)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : 'Could not load the saved syllabus.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [course, reload]);

  const updateInput = (change: () => void) => {
    change();
    setPreview(null);
    setActionError('');
    setSavedMessage('');
  };

  const handlePreview = async (useAi: boolean) => {
    setActionError('');
    setSavedMessage('');
    setPreview(null);
    setPreviewing(useAi ? 'ai' : 'rules');
    try {
      const result = await previewCourseSyllabus(course, {
        text: text.trim(),
        ...(termStart ? { term_start: termStart } : {}),
        ...(year ? { year: Number(year) } : {}),
        use_ai: useAi,
      });
      setPreview(result);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not preview this syllabus.');
    } finally {
      setPreviewing(null);
    }
  };

  const handleSave = async () => {
    if (!preview?.syllabus.entries.length) return;
    setSaving(true);
    setActionError('');
    setSavedMessage('');
    try {
      const result = await saveCourseSyllabus(course, preview.syllabus);
      setSaved(result);
      setPreview(null);
      setText('');
      setSavedMessage(`Saved ${result.entries.length} entries for ${course}.`);
      onSaved?.(result);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not save this syllabus.');
    } finally {
      setSaving(false);
    }
  };

  return <section className="course-syllabus-panel">
    <button type="button" className="syllabus-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
      <span className="syllabus-toggle-main"><BookOpen aria-hidden="true" size={15} /><strong>Syllabus</strong>
        <span className="syllabus-toggle-course">{course}</span>
      </span>
      <span className="syllabus-toggle-status">{loading ? 'Loading' : saved ? `${saved.entries.length} entries` : 'Not added'}
        <span className="syllabus-toggle-action">{open ? 'Close' : 'Open'}</span>
      </span>
    </button>

    {open && <div id={panelId} className="syllabus-content">
      {loadError && <p className="syllabus-error" role="alert">{loadError} <button type="button" onClick={() => setReload((value) => value + 1)}>Retry</button></p>}
      {loading && <p className="syllabus-state" aria-live="polite">Loading saved syllabus…</p>}
      {!loading && !loadError && saved && <div className="syllabus-saved">
        <div className="syllabus-saved-heading"><div><h4>{saved.title}</h4><span>{saved.entries.length} scheduled entries · Saved {updatedLabel(saved.updated_at)}</span></div></div>
        <SyllabusWarnings warnings={saved.warnings} />
        <EntryList entries={saved.entries} />
      </div>}
      {!loading && !loadError && !saved && <p className="syllabus-state">No syllabus schedule is saved for this course yet.</p>}

      <details className="syllabus-import">
        <summary>{saved ? 'Replace syllabus schedule' : 'Add syllabus schedule'}</summary>
        <div className="syllabus-import-body">
          <label htmlFor={`${panelId}-text`}>Paste syllabus or weekly schedule</label>
          <textarea id={`${panelId}-text`} maxLength={100000} rows={5} value={text} onChange={(event) => updateInput(() => setText(event.target.value))} placeholder={'Paste the dated or weekly course schedule. For example:\nWeek 1 | Introductory material | Chapter 1\nSep 25 | Quiz 2: covers chapters 1–2'} />
          <div className="syllabus-context-fields">
            <div><label htmlFor={`${panelId}-term-start`}>First day of Week 1 <span>Optional</span></label><input id={`${panelId}-term-start`} type="date" value={termStart} onChange={(event) => updateInput(() => setTermStart(event.target.value))} /></div>
            <div><label htmlFor={`${panelId}-year`}>Year for undated dates <span>Optional</span></label><input id={`${panelId}-year`} type="number" min={2000} max={2100} inputMode="numeric" value={year} onChange={(event) => updateInput(() => setYear(event.target.value))} placeholder="2026" /></div>
          </div>
          <p className="syllabus-help">Rules preview runs without AI. Week numbers need the Week 1 start date; dates without a year need a year or an unambiguous year in the pasted text.</p>
          <div className="syllabus-preview-actions">
            <button type="button" className="syllabus-action syllabus-action--primary" onClick={() => void handlePreview(false)} disabled={!text.trim() || previewing !== null || saving}>
              {previewing === 'rules' ? <LoaderCircle aria-hidden="true" size={14} className="syllabus-spin" /> : <CalendarDays aria-hidden="true" size={14} />}
              {previewing === 'rules' ? 'Reading schedule…' : 'Preview with rules'}
            </button>
            <button type="button" className="syllabus-action syllabus-action--ai" onClick={() => void handlePreview(true)} disabled={!text.trim() || previewing !== null || saving}>
              {previewing === 'ai' ? <LoaderCircle aria-hidden="true" size={14} className="syllabus-spin" /> : <Bot aria-hidden="true" size={14} />}
              {previewing === 'ai' ? 'Reviewing…' : 'Review with AI'}
            </button>
          </div>
          <p className="syllabus-ai-note">AI review is optional and uses the shared AI allowance. Both previews keep dates and evidence grounded in the pasted text.</p>

          {actionError && <p className="syllabus-error" role="alert">{actionError}</p>}
          {savedMessage && <p className="syllabus-success" role="status">{savedMessage}</p>}
          {preview && <div className="syllabus-preview" aria-live="polite">
            <div className={'syllabus-preview-heading' + (preview.method === 'ai' ? ' syllabus-preview-heading--ai' : '')}><div><h4>Review before saving</h4><span>{preview.syllabus.entries.length} entries · {preview.method === 'ai' ? 'AI reviewed' : 'Rules parsed'}</span></div></div>
            <SyllabusWarnings warnings={preview.warnings} />
            <EntryList entries={preview.syllabus.entries} />
            <button type="button" className="syllabus-action syllabus-action--save" onClick={() => void handleSave()} disabled={!preview.syllabus.entries.length || saving || previewing !== null}>
              {saving ? <LoaderCircle aria-hidden="true" size={14} className="syllabus-spin" /> : <Save aria-hidden="true" size={14} />}
              {saving ? 'Saving…' : 'Save reviewed schedule'}
            </button>
          </div>}
        </div>
      </details>
    </div>}
  </section>;
}

export default CourseSyllabusPanel;
