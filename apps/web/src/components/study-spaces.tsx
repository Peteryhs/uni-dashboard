import { ChevronRight, ExternalLink } from 'lucide-react';

import { BlurFade } from '@/components/ui/blur-fade';
import { BlurFadeDisclosure } from '@/components/ui/blur-fade-disclosure';
import type { CardState, StudySpaceBest, StudySpaceLibrary, StudySpacesData } from '@/lib/contract';
import {
  bestSpaceDetail,
  bestSpaceTitle,
  formatPeopleCapacity,
  formatPeopleCount,
  occupancyLabel,
  studySpacePercent,
} from '@/lib/study-spaces';
import { shortAge } from '@/lib/time';
import './study-spaces.css';

const WAITZ_URL = 'https://waitz.io/live/waterloo';

function isSaved(state: CardState | undefined): boolean {
  return state === 'stale' || state === 'dead';
}

function libraryAccessibleLabel(library: StudySpaceLibrary): string {
  if (!library.is_open) {
    const summary = library.summary?.trim();
    return `${library.name}, closed${summary ? `, ${summary}` : ''}`;
  }
  const percent = studySpacePercent(library);
  if (percent == null) return `${library.name}, open, no occupancy count`;
  return `${library.name}, open, ${percent} percent full, ${occupancyLabel(percent)}`;
}

function closedLibrarySummary(library: StudySpaceLibrary): string {
  const summary = library.summary?.trim();
  return summary ? `${library.name}: ${summary}` : `${library.name}: Closed`;
}

function closedLibraryDetail(library: StudySpaceLibrary): string {
  const summary = library.summary?.trim();
  if (!summary) return 'This library is closed.';
  if (/^closed\b/i.test(summary)) return summary.charAt(0).toUpperCase() + summary.slice(1);
  return `This library is closed. ${summary}`;
}

function StudySpaceLead({ best, libraries, openCount, saved }: {
  best: StudySpaceBest | null;
  libraries: StudySpaceLibrary[];
  openCount: number;
  saved: boolean;
}) {
  if (best) {
    const percent = studySpacePercent(best);
    const detail = bestSpaceDetail(best);
    return <div className="study-space-lead">
      <div className="study-space-lead-copy">
        <span className="study-space-lead-label">{saved ? 'Last known most room' : 'Most room right now'}</span>
        <h3>{bestSpaceTitle(best)}</h3>
        <p className="study-space-lead-detail">
          <span className="sr-only">{detail}</span>
          <span className="study-space-lead-detail-visual" aria-hidden="true">
            {detail === 'No count'
              ? <span>No count</span>
              : <>
                <span>{formatPeopleCount(best.people)}</span>
                <span className="study-space-lead-separator">·</span>
                <strong className="study-space-lead-percent">{percent}%</strong>
                <span>of {best.capacity}</span>
              </>}
          </span>
        </p>
      </div>
    </div>;
  }

  const firstLibrary = libraries[0];
  if (openCount === 0 && firstLibrary) {
    return <div className="study-space-lead study-space-lead--message">
      <h3>{saved ? 'Last known: all library spaces were closed' : 'All library spaces are closed'}</h3>
      <p className="study-space-lead-note">{closedLibrarySummary(firstLibrary)}</p>
    </div>;
  }

  return <div className="study-space-lead study-space-lead--message">
    <h3>Libraries are open</h3>
    <p className="study-space-lead-note">Floor occupancy is unavailable</p>
  </div>;
}

function StudySpaceCard({ library }: { library: StudySpaceLibrary }) {
  const floors = library.floors ?? [];

  // A closed library has no current occupancy to report. Showing "0% Quiet" beside "Closed"
  // would invent a reading, so the card stays a short, honest state instead of a disclosure.
  if (!library.is_open) {
    return <article className="study-space-card study-space-card--closed">
      <div className="study-space-card-body">
        <span className="study-space-card-head">
          <strong>{library.name}</strong>
          <span className="study-space-state">Closed</span>
        </span>
        <p className="study-space-closed-line">{closedLibraryDetail(library)}</p>
      </div>
    </article>;
  }

  const percent = studySpacePercent(library);
  const label = occupancyLabel(percent);
  const count = formatPeopleCapacity(library.people, library.capacity);

  return <BlurFadeDisclosure
    className="study-space-card"
    contentClassName="study-space-card-detail"
    summary={<>
      <span className="sr-only">{libraryAccessibleLabel(library)}</span>
      <span className="study-space-card-body" aria-hidden="true">
        <span className="study-space-card-head">
          <strong>{library.name}</strong>
          <span className="study-space-state is-open">Open</span>
        </span>
        <span className="study-space-card-figure">
          {percent == null
            ? <strong className="study-space-card-percent is-unavailable">No count</strong>
            : <>
              <strong className="study-space-card-percent">{percent}%</strong>
              {count && <span className="study-space-card-count">{count}</span>}
            </>}
        </span>
        <span className="study-space-bar" aria-hidden="true"><span style={{ width: `${percent ?? 0}%` }} /></span>
        {percent != null && <span className="study-space-card-foot">{label}</span>}
      </span>
      <ChevronRight className="study-space-chevron" size={15} aria-hidden="true" />
    </>}
  >
    {floors.length > 0 ? <div>
      <span className="study-space-detail-label">Floors</span>
      <ul className="study-space-floors" aria-label={`${library.name} floors`}>
        {floors.map(floor => {
          const floorPercent = studySpacePercent(floor);
          const floorCount = formatPeopleCapacity(floor.people, floor.capacity);
          return <li className="study-space-floor" key={floor.id}>
            <span className="study-space-floor-head">
              <span className="study-space-floor-name">{floor.name}</span>
              <span className={'study-space-floor-state' + (floor.is_open ? ' is-open' : '')}>{floor.is_open ? 'Open' : 'Closed'}</span>
            </span>
            <span className="study-space-floor-meta">
              <strong>{floorPercent == null ? 'No count' : `${floorPercent}%`}</strong>
              {floorCount && <span>{floorCount}</span>}
            </span>
          </li>;
        })}
      </ul>
    </div> : <p className="study-space-empty-detail">No floor occupancy is reported for this library.</p>}
  </BlurFadeDisclosure>;
}

function StudySpacesAbout() {
  return <BlurFadeDisclosure
    className="study-space-about"
    summary={<><span>About occupancy</span><ChevronRight size={14} aria-hidden="true" /></>}
  >
    <p>Waitz reports people counts, capacity is venue-reported, and closed spaces may keep a last count.</p>
    <a href={WAITZ_URL} target="_blank" rel="noopener noreferrer">Live occupancy on Waitz <ExternalLink size={13} aria-hidden="true" /></a>
  </BlurFadeDisclosure>;
}

export function StudySpacesSection({ data, state, observedAt, now }: {
  data?: StudySpacesData;
  state?: CardState;
  observedAt?: number | null;
  now: number;
}) {
  if (!data) return null;

  const libraries = data.libraries ?? [];
  const saved = isSaved(state);
  const openCount = Number.isFinite(data.open_count)
    ? data.open_count
    : libraries.filter(library => library.is_open).length;
  const totalCount = Number.isFinite(data.total_count) ? data.total_count : libraries.length;
  const age = observedAt != null ? `${shortAge(observedAt, now)} ago` : '';
  const status = saved
    ? ['Saved', age ? `checked ${age}` : ''].filter(Boolean).join(' · ')
    : [`${openCount} of ${totalCount} open`, age ? `checked ${age}` : ''].filter(Boolean).join(' · ');
  const unavailable = libraries.length === 0 && (state === 'failed' || state === 'degraded');

  return <BlurFade as="section" className="content-section study-spaces" id="study" inView duration={0.45} offset={10} blur="6px" direction="up" aria-labelledby="study-title">
    <div className="section-head">
      <h2 id="study-title">Study spaces</h2>
      {libraries.length > 0 && <span className={'section-count study-space-status' + (saved ? ' is-saved' : '')}>{status}</span>}
    </div>
    {libraries.length === 0
      ? <div className={'state-panel study-space-state' + (unavailable ? ' study-space-state--error' : '')} role={unavailable ? 'alert' : undefined}>
        {unavailable
          ? <>
            <p className="study-space-state-title">Study space data is unavailable right now.</p>
            <p>Waitz did not answer the latest check. Saved occupancy appears here when it is available.</p>
          </>
          : <p>No study-space checks yet. Use Refresh at the top to fetch live occupancy.</p>}
      </div>
      : <>
        <StudySpaceLead best={data.best} libraries={libraries} openCount={openCount} saved={saved} />
        <div className="study-space-grid">
          {libraries.map(library => <StudySpaceCard key={library.id} library={library} />)}
        </div>
        <StudySpacesAbout />
      </>}
  </BlurFade>;
}
