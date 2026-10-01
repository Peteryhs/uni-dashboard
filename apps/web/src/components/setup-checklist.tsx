import type { SetupStatus } from '@/lib/api';
import './setup-checklist.css';

export function SetupChecklist({ status, onOpen, onDismiss }: {
  status: SetupStatus;
  onOpen: (step: number) => void;
  onDismiss: () => void;
}) {
  const steps = [
    { name: 'Connect your timetable', detail: 'Get a Google Calendar or Waterloo Portal subscription link.', configured: status.schedule_configured, synced: status.schedule_synced, step: 0 },
    { name: 'Connect LEARN deadlines', detail: 'Get the calendar feed for your courses and tasks.', configured: status.learn_configured, synced: status.learn_synced, step: 1 },
  ];
  const count = steps.filter(item => item.synced).length;
  return <section className="setup-checklist" aria-labelledby="setup-checklist-title">
    <div className="setup-checklist-head">
      <div><h2 id="setup-checklist-title">Set up your Waterloo day</h2><p>Your dashboard is ready for your timetable and deadlines.</p></div>
      <button type="button" onClick={onDismiss} className="setup-checklist-later">Later</button>
    </div>
    <p className="setup-checklist-progress" role="status">{count} of 2 feeds synced</p>
    <ul>{steps.map(item => <li key={item.step}>
      <span className={'setup-checklist-mark' + (item.synced ? ' is-complete' : '')} aria-hidden="true">{item.synced ? '✓' : item.step + 1}</span>
      <div><h3>{item.name}</h3><p>{item.synced ? 'Feed synced. Events will appear when your calendar has them.' : item.configured ? 'Feed saved. Check the guide’s Review step to confirm it syncs.' : item.detail}</p></div>
      <button type="button" onClick={() => onOpen(item.synced || item.configured ? 4 : item.step)}>{item.synced ? 'Review' : item.configured ? 'Check sync' : 'Show me how'}</button>
    </li>)}</ul>
    <div className="setup-checklist-footer"><p>Then add dining preferences, course resources, or office hours.</p><button type="button" onClick={() => onOpen(2)}>Explore optional setup</button></div>
  </section>;
}
