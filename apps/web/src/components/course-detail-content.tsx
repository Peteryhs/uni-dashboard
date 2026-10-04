import { useId } from 'react';
import { CalendarMarkdown } from '@/components/calendar-markdown';
import './course-detail-content.css';

export type CourseDetailContentProps = {
  description?: string | null;
  topics?: string[];
  readings?: string[];
  syllabusScope?: 'date' | 'period' | null;
  syllabusEvidence?: string[];
};

function cleanLines(values?: string[]) {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

/** Keeps course and task detail fields on one compact, readable type scale. */
export function CourseDetailContent({
  description,
  topics,
  readings,
  syllabusScope,
  syllabusEvidence,
}: CourseDetailContentProps) {
  const id = useId();
  const cleanDescription = description?.trim();
  const topicItems = cleanLines(topics);
  const readingItems = cleanLines(readings);
  const evidenceItems = cleanLines(syllabusEvidence);

  if (!cleanDescription && topicItems.length === 0 && readingItems.length === 0 && evidenceItems.length === 0) return null;

  return <div className="course-detail-content">
    {cleanDescription && <section className="course-detail-content__section" aria-labelledby={`${id}-description`}>
      <h4 className="course-detail-content__label" id={`${id}-description`}>Description</h4>
      <CalendarMarkdown description={cleanDescription} showLabel={false} />
    </section>}
    {topicItems.length > 0 && <section className="course-detail-content__section" aria-labelledby={`${id}-topics`}>
      <h4 className="course-detail-content__label" id={`${id}-topics`}>{syllabusScope === 'period' ? 'Topics for this period' : 'Topics'}</h4>
      <ul className="course-detail-content__topics" aria-label="Topics">
        {topicItems.map((topic, index) => <li key={`${topic}-${index}`}>{topic}</li>)}
      </ul>
    </section>}
    {readingItems.length > 0 && <section className="course-detail-content__section" aria-labelledby={`${id}-readings`}>
      <h4 className="course-detail-content__label" id={`${id}-readings`}>Readings</h4>
      <ul className="course-detail-content__readings">
        {readingItems.map((reading, index) => <li key={`${reading}-${index}`}>{reading}</li>)}
      </ul>
    </section>}
    {evidenceItems.length > 0 && <details className="course-detail-content__evidence">
      <summary>Syllabus source text</summary>
      <ul>{evidenceItems.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>
    </details>}
  </div>;
}
