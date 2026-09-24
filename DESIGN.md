---
version: alpha
name: Uni Dashboard
colors:
  background: "#1d1f23"
  surface: "#292c32"
  border: "#494d55"
  text: "#f5f6f7"
  muted: "#aeb4bc"
  ai: "#3478eb"
  aiText: "#78adff"
typography:
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: 8px
  panel: 16px
spacing:
  md: 16px
components:
  recommendation:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
  ai-marker:
    backgroundColor: "{colors.ai}"
    textColor: "{colors.text}"
---

## Overview

Uni Dashboard is a glanceable daily tool for a Waterloo student. The first screen answers what to do next using the backend recommendation ranking. It shows the top recommendation and two more. Calendar, Dining menu, and Courses follow in one scroll. Settings opens from the top context row.

## Colors

Dark grey is the canvas. Near-white is the default for primary information. Muted grey supports metadata. Blue text and restrained rounded blue rules identify AI output and controls, including dining recommendations and text parsing. Realtime recommendation cards use blue text without a rule. Blue never implies that the whole recommendation engine is AI generated. Amber and red are reserved for stale data and alerts. Dietary tags may retain their own useful colours.

## Typography

Use Inter or a system sans fallback. The top recommendation title is the only display-sized type and scales down for long titles. All other headings and controls use a compact scale. Keep times in tabular figures and all labels in sentence case.

## Layout

The page is a centered column capped at 1040px. Two equal recommendation cards lead: the left holds the top recommendation and a narrow next-task strip; the right holds two more recommendations and the largest distinct upcoming task. All sections align to the same column. Calendar shows today and tomorrow in full by default, with one-week and explicitly requested 31-day views and a clear return to two days. A compact weekly deadline horizon follows the visible days until the full calendar is opened. Due and opening work follows the calendar. The dining menu shows its actual service date and the top ranked restaurant in blue text; dining hall names omit the Residence Dining Hall suffix. Ranked outlet verdicts and highlighted dishes appear in their matching menu cards. Courses show read-only previews, with links, syllabi, and course group settings managed from Settings. Mobile stacks the cards; no header, footer, or fixed navigation covers the content.

## Elevation & Depth

Use solid surfaces and thin borders. No glows, gradients, glass, decorative shadows, or animated status decoration.

## Shapes

Cards use a 16px radius; controls use a smaller radius. Shapes signal grouping and affordance, not personality.

## Components

The recommendation card shows kind, title, one short contextual line, timing, and progress only when an event is in progress. Selecting a recommendation reveals details, source link, and available actions. View menu stays within the dashboard and scrolls to its dining section. Calendar rows show course, event kind, and whether a deadline has an exact time; details retain source, scope, location, links, and syllabus evidence. Dining highlights use blue names and slim rules on the posted dishes themselves; personalized reasons stay with the matching dish or outlet. The top dining recommendation names the restaurant without an AI badge or icon. Settings uses flat groups: Dining, Schedule, Courses, and Connections. The settings drawer contains no icons. Course matching is separate from course materials, and expanded courses have labeled link fields and syllabus review. Long course import and syllabus review flows live inside the Settings drawer, away from daily course scanning. Calendar, menu, courses, and settings preserve the backend's loading, error, empty, freshness, and source states. A missing campus status check is never rendered as an all clear. Section headings are small and direct; explanatory subtitles and numbered labels are omitted.

## Do's and Don'ts

- Lead with the backend ranking rather than a fixed class or food card.
- Keep AI output blue and label it accurately. Never use sparkle icons.
- Show the AI-highlighted posted dishes for lunch. Never substitute the first menu rows when a saved AI pick exists.
- Keep source warnings in a disclosure without filling the first screen with diagnostics.
- Avoid duplicate summaries, decorative metrics, and a dense card grid on Today.
