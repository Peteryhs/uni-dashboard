import { useEffect, useState } from 'react';
import { CourseSyllabusPanel } from './course-syllabus-panel';
import { usePreferences } from '@/lib/preferences-store';
import { previewCourseImport, saveCourseResources } from '@/lib/api';
import type { CalendarData, CourseResource } from '@/lib/contract';

type CourseSettingsTabProps = {
  data?: CalendarData;
  pending: boolean;
  error: boolean;
  focusCourse?: string | null;
  onRetry: () => void;
  onSaved: () => void;
};

export function CourseSettingsTab({ data, pending, error, focusCourse, onRetry, onSaved }: CourseSettingsTabProps) {
  const { preferences, setSection, setGroupNumber } = usePreferences();
  const courses = data?.courses ?? [];
  const courseNames = courses.map((course) => course.course).join('\u0000');
  const [expandedCourse, setExpandedCourse] = useState<string | null>(null);

  useEffect(() => {
    if (focusCourse && courseNames.split('\u0000').includes(focusCourse)) {
      setExpandedCourse((current) => current === focusCourse ? current : focusCourse);
    }
  }, [focusCourse, courseNames]);

  return <div className="settings-course-tab">
    <section className="settings-course-global">
      <div className="settings-course-heading">
        <h3>Course matching</h3>
        <p>Use your LEARN section and group to match schedule items.</p>
      </div>
      <div className="settings-course-global-fields">
        <label>
          <span>Section number</span>
          <input
            type="number"
            min={1}
            max={999}
            placeholder="e.g. 2"
            value={preferences.section ?? ''}
            onChange={(event) => {
              const value = event.target.value.trim();
              setSection(value ? Number(value) : null);
            }}
          />
        </label>
        <label>
          <span>Group number</span>
          <input
            type="number"
            min={1}
            max={999}
            placeholder="e.g. 1"
            value={preferences.groupNumber ?? ''}
            onChange={(event) => {
              const value = event.target.value.trim();
              setGroupNumber(value ? Number(value) : null);
            }}
          />
        </label>
      </div>
    </section>

    <section className="settings-course-list" aria-labelledby="settings-course-list-title">
      <div className="settings-course-list-heading">
        <h3 id="settings-course-list-title">Course materials</h3>
        <p>Choose a course to manage its links and syllabus.</p>
      </div>
      {pending && !data && <p className="settings-course-state" role="status">Loading courses…</p>}
      {error && !data && <div className="settings-course-state settings-course-state--error" role="alert">
        <span>Courses could not be loaded.</span>
        <button type="button" onClick={onRetry}>Try again</button>
      </div>}
      {data && courses.length === 0 && <p className="settings-course-state">No courses appear in the loaded calendar feed. Connect a schedule feed to add course materials here.</p>}
      {courses.length > 0 && <div className="settings-course-rows">
        {courses.map((course) => <details
          className="settings-course-row"
          key={course.course}
          open={expandedCourse === course.course}
          onToggle={(event) => {
            const isOpen = event.currentTarget.open;
            setExpandedCourse((current) => isOpen ? course.course : current === course.course ? null : current);
          }}
        >
          <summary>
            <span className="settings-course-row-name">{course.course}</span>
            <span className="settings-course-row-meta">{course.resources.length ? `${course.resources.length} ${course.resources.length === 1 ? 'link' : 'links'}` : 'No links'}</span>
          </summary>
          {expandedCourse === course.course && <div className="settings-course-row-content">
            {course.learn_url && <a className="settings-course-learn" href={course.learn_url} target="_blank" rel="noopener noreferrer">Open course in LEARN</a>}
            <CourseLinkEditor course={course} onSaved={onSaved} />
            <CourseSyllabusPanel course={course.course} onSaved={onSaved} />
          </div>}
        </details>)}
      </div>}
    </section>
  </div>;
}

function CourseLinkEditor({ course, onSaved }: { course: CalendarData['courses'][number]; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<CourseResource['kind']>('resource');
  const [importText, setImportText] = useState('');
  const [preview, setPreview] = useState<CourseResource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [importPreviewed, setImportPreviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (resources: CourseResource[]) => {
    setBusy(true);
    setError('');
    try {
      await saveCourseResources(course.course, resources);
      setTitle('');
      setUrl('');
      setPreview([]);
      setImportPreviewed(false);
      setImportText('');
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save course links.');
    } finally {
      setBusy(false);
    }
  };

  const previewImport = async () => {
    setBusy(true);
    setError('');
    try {
      const links = await previewCourseImport(importText);
      setPreview(links);
      setSelected(links.map((link) => link.url));
      setImportPreviewed(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read the links.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="settings-course-editor">
    <div className="settings-course-editor-heading"><h4>Saved links</h4><span>{course.resources.length}</span></div>
    {course.resources.length > 0 ? <ul className="settings-course-resource-list">
      {course.resources.map((link) => <li key={link.url}>
        <a href={link.url} target="_blank" rel="noopener noreferrer">{link.title}</a>
        <span>{link.kind}</span>
        <button type="button" disabled={busy} onClick={() => void save(course.resources.filter((item) => item.url !== link.url))} aria-label={'Remove ' + link.title}>Remove</button>
      </li>)}
    </ul> : null}

    <form className="settings-course-add" onSubmit={(event) => {
      event.preventDefault();
      void save([...course.resources, { title: title.trim(), url: url.trim(), kind }]);
    }}>
      <h4>Add a link</h4>
      <label className="settings-course-add-title"><span>Title</span><input placeholder="Course notes" value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
      <label className="settings-course-add-kind"><span>Type</span><select value={kind} onChange={(event) => setKind(event.target.value as CourseResource['kind'])}>
        <option value="resource">Resource</option><option value="textbook">Textbook</option><option value="learn">LEARN</option>
      </select></label>
      <label className="settings-course-add-url"><span>URL</span><input placeholder="https://…" type="url" value={url} onChange={(event) => setUrl(event.target.value)} required /></label>
      <button type="submit" disabled={busy || !title.trim() || !url.trim()}>{busy ? 'Saving…' : 'Add link'}</button>
    </form>

    <details className="settings-course-import">
      <summary>Import links from a LEARN page</summary>
      <div className="settings-course-import-body">
        <textarea
          aria-label="Page content or links"
          placeholder="Paste a LEARN page or links"
          value={importText}
          onChange={(event) => { setImportText(event.target.value); setImportPreviewed(false); setPreview([]); }}
          onPaste={(event) => {
            const html = event.clipboardData.getData('text/html');
            if (html && /href\s*=/.test(html)) {
              event.preventDefault();
              setImportText(html.slice(0, 100_000));
              setImportPreviewed(false);
              setPreview([]);
            }
          }}
        />
        <div className="settings-course-import-actions">
          <input aria-label="Import HTML or text file" type="file" accept=".html,.htm,.txt,text/html,text/plain" onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) {
              setImportText((await file.text()).slice(0, 100_000));
              setImportPreviewed(false);
              setPreview([]);
            }
          }} />
          <button type="button" disabled={busy || !importText.trim()} onClick={() => void previewImport()}>{busy ? 'Reading…' : 'Preview'}</button>
        </div>
        {preview.length > 0 && <div className="settings-course-import-preview">
          {preview.map((link) => <label key={link.url}>
            <input type="checkbox" checked={selected.includes(link.url)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, link.url] : current.filter((value) => value !== link.url))} />
            <span>{link.title}</span>
          </label>)}
          <button type="button" disabled={busy || selected.length === 0} onClick={() => void save([...course.resources, ...preview.filter((link) => selected.includes(link.url))])}>Save {selected.length} links</button>
        </div>}
        {importPreviewed && preview.length === 0 && <p className="settings-course-empty">No links were found in that page.</p>}
      </div>
    </details>
    {error && <p className="settings-course-error" role="alert">{error}</p>}
  </div>;
}
