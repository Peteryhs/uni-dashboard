import type { ReactNode } from 'react';
import './calendar-markdown.css';

type Block = { kind: 'heading' | 'paragraph' | 'list' | 'quote'; text: string; marker?: string };

/** Feed descriptions are untrusted text. Parse the common Markdown forms without rendering HTML. */
export function parseCalendarMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const raw of source.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    const numbered = /^(\d+)[.)]\s+(.+)$/.exec(line);
    if (heading) { flush(); blocks.push({ kind: 'heading', text: heading[1] }); }
    else if (bullet) { flush(); blocks.push({ kind: 'list', text: bullet[1], marker: '•' }); }
    else if (numbered) { flush(); blocks.push({ kind: 'list', text: numbered[2], marker: numbered[1] }); }
    else if (line.startsWith('>')) { flush(); blocks.push({ kind: 'quote', text: line.slice(1).trim() }); }
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

const inlinePattern = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)|\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\*([^*\n]+)\*|_([^_\n]+)_/g;

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const key = `${index}-${match[0]}`;
    if (match[1]) nodes.push(<a key={key} href={match[2]} target="_blank" rel="noopener noreferrer">{match[1]}</a>);
    else if (match[3] || match[4]) nodes.push(<strong key={key}>{match[3] || match[4]}</strong>);
    else if (match[5]) nodes.push(<code key={key}>{match[5]}</code>);
    else nodes.push(<em key={key}>{match[6] || match[7]}</em>);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function calendarMarkdownPreview(source: string): string {
  return parseCalendarMarkdown(source).map((block) => block.text
    .replace(/\[([^\]]+)]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/\*\*|__|[`*_]/g, '')).join(' · ');
}

export function CalendarMarkdown({ description }: { description: string }) {
  const blocks = parseCalendarMarkdown(description);
  if (!blocks.length) return null;
  return <div className="calendar-markdown" aria-label="Event description">
    <span className="calendar-markdown__label">Description</span>
    <div className="calendar-markdown__blocks">{blocks.map((block, index) => {
      const content = inline(block.text);
      if (block.kind === 'heading') return <h4 key={index}>{content}</h4>;
      if (block.kind === 'quote') return <blockquote key={index}>{content}</blockquote>;
      if (block.kind === 'list') return <div className="calendar-markdown__item" key={index}><span className="calendar-markdown__bubble" aria-hidden="true">{block.marker}</span><span>{content}</span></div>;
      return <p key={index}>{content}</p>;
    })}</div>
  </div>;
}
