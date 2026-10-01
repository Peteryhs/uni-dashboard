import { useEffect, useId, useState } from 'react';
import './feed-walkthrough.css';

type WalkthroughProvider = 'google' | 'learn';

type WalkthroughStage = {
  title: string;
  description: string;
};

const STAGES: Record<WalkthroughProvider, WalkthroughStage[]> = {
  google: [
    {
      title: 'Open Google Calendar settings',
      description: 'In the web version of Google Calendar, open Settings from the gear menu.',
    },
    {
      title: 'Choose your calendar',
      description: 'In the left rail, open Settings for my calendars and select the calendar with your timetable.',
    },
    {
      title: 'Open Integrate calendar',
      description: 'Scroll to Integrate calendar. This page contains the private addresses for the selected calendar.',
    },
    {
      title: 'Copy the secret iCal address',
      description: 'Copy Secret address in iCal format, then paste it into the field below. Keep this URL private.',
    },
  ],
  learn: [
    {
      title: 'Open LEARN Calendar',
      description: 'Open Calendar from the LEARN homepage or from one of your courses.',
    },
    {
      title: 'Open Calendar settings',
      description: 'Open the calendar settings menu to manage feeds for your courses.',
    },
    {
      title: 'Enable feeds and save',
      description: 'Turn on calendar feeds, then choose Save so LEARN makes the subscription available.',
    },
    {
      title: 'Subscribe to all calendars and tasks',
      description: 'Choose Subscribe, select All Calendars and Tasks, and copy the URL that appears.',
    },
  ],
};

export function FeedWalkthrough({ provider }: { provider: WalkthroughProvider }) {
  const [stage, setStage] = useState<number | null>(0);
  const headingId = useId();
  const stages = STAGES[provider];
  const current = stage === null ? null : stages[stage];

  useEffect(() => {
    setStage(0);
  }, [provider]);

  return (
    <section className="feed-walkthrough" aria-labelledby={headingId}>
      <div className="feed-walkthrough-header">
        <h3 id={headingId}>Find your subscription link</h3>
        <a href={provider === 'google' ? 'https://calendar.google.com/' : 'https://learn.uwaterloo.ca/'} target="_blank" rel="noopener noreferrer">Open {provider === 'google' ? 'Google Calendar' : 'LEARN'}</a>
      </div>
      <ol className="feed-walkthrough-stages">
        {stages.map((item, index) => (
          <li key={item.title} className={index === stage ? 'is-active' : ''}>
            <button type="button" aria-expanded={index === stage} aria-controls={`${headingId}-${index}`} onClick={() => setStage(index === stage ? null : index)}>
              <span className="feed-stage-number" aria-hidden="true">{index + 1}</span>
              <span>{item.title}</span>
            </button>
            <div id={`${headingId}-${index}`} className="feed-stage-content" hidden={index !== stage}>
              <p>{item.description}</p>
            </div>
          </li>
        ))}
      </ol>
      <span className="sr-only" role="status">{stage !== null && current ? `Instruction ${stage + 1} of ${stages.length}: ${current.title}` : 'Select an instruction to view its details.'}</span>
    </section>
  );
}
