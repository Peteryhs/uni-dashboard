---
version: alpha
name: Uni Dashboard
colors:
  primary: "#f5f6f7"
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
  divider:
    backgroundColor: "{colors.border}"
  source-note:
    backgroundColor: "{colors.background}"
    textColor: "{colors.muted}"
  ai-output:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.aiText}"
  ai-rule:
    backgroundColor: "{colors.ai}"
  primary-control:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.background}"
---

## Overview

Uni Dashboard is a glanceable daily tool for a Waterloo student. The first screen answers what to do next using the backend recommendation ranking. It shows the top recommendation and two more. Calendar, Dining menu, and Courses follow in one scroll. Settings opens from the top context row.

## Colors

Dark grey is the canvas. Near-white is the default for primary information. Muted grey supports metadata. Blue text and restrained rounded blue rules identify AI output and controls, including dining recommendations and text parsing. Realtime recommendation cards use blue text without a rule. Blue never implies that the whole recommendation engine is AI generated. Amber and red are reserved for stale data and alerts. Dietary tags may retain their own useful colours.

## Typography

Use Inter or a system sans fallback. The top recommendation title is the only display-sized type and scales down for long titles. All other headings and controls use a compact scale. Keep times in tabular figures and all labels in sentence case.

## Layout

The page is a centered column capped at 1040px. Two equal recommendation cards lead: the left holds the top recommendation and a narrow next-task strip; the right holds two more recommendations and the largest distinct upcoming task. All sections align to the same column. Calendar shows today and the next two days in full by default, with one-week and explicitly requested 31-day views and a clear return to three days. A compact weekly deadline horizon follows the visible days until the full calendar is opened. Due and opening work follows the calendar. The dining menu shows its actual service date and the top ranked restaurant in blue text; dining hall names omit the Residence Dining Hall suffix. Ranked outlet verdicts and highlighted dishes appear in their matching menu cards. Courses show read-only previews, with links, syllabi, and course group settings managed from Settings. Mobile stacks the cards; no header, footer, or fixed navigation covers the content.

## Elevation & Depth

Use solid surfaces and thin borders. No glows, gradients, glass, decorative shadows, or animated status decoration.

## Course details

Descriptions, topics, readings, and syllabus evidence share one detail layout across calendar events, recommendations, and syllabus review. Web content uses Inter at 13px with a 1.5–1.55 line height; section labels use 12px semibold muted text. Keep labels on their own line and align every section to the same left edge. Topics wrap as subtle tags, readings use bullet lists, and source evidence stays in a disclosure. Markdown paragraphs, emphasis, and lists retain this body scale; headings add weight rather than becoming display text. Android uses the equivalent Material body and label styles with the same grouping and alignment.

## Shapes

Cards use a 16px radius; controls use a smaller radius. Shapes signal grouping and affordance, not personality.

## Components

The recommendation card shows kind, title, one short contextual line, timing, and progress only when an event is in progress. Selecting a recommendation reveals details, source link, and available actions. View menu stays within the dashboard and scrolls to its dining section. Calendar rows show course, event kind, and whether a deadline has an exact time; details retain source, scope, location, links, and syllabus evidence. Dining highlights use blue names and slim rules on the posted dishes themselves; personalized reasons stay with the matching dish or outlet. The top dining recommendation names the restaurant without an AI badge or icon. Settings uses flat groups: Dining, Schedule, Courses, Connections, Status, Recommendations, and About. Connections manages setup; Status owns backend reachability, last successful source updates, failures, and runtime details; About contains app information. Recommendations explains actual server ranking decisions, including deferred and suppressed items. The settings drawer uses text navigation; refresh controls and the close button retain their functional icons. Course matching is separate from course materials, and expanded courses have labeled link fields and syllabus review. Long course import and syllabus review flows live inside the Settings drawer, away from daily course scanning. Calendar, menu, courses, and settings preserve the backend's loading, error, empty, freshness, and source states. A missing campus status check is never rendered as an all clear. Section headings are small and direct; explanatory subtitles and numbered labels are omitted.

Schedule changes use compact before-and-after values with one directional arrow. Location and question icons do not flank these values; unconfirmed changes use explicit text. Graphics must encode timing, progress, dietary information, or a concrete change rather than repeat the nearby label. Android keeps the same information hierarchy with Material 3 Expressive type, colour roles, and restrained containment.

Menu dietary indicators are small inline icons beside the dish title, without a separate tag row or letter badges. Use carrot for vegetarian, sprout for vegan, crescent for halal, and crossed-out wheat or milk for the corresponding made-without tags; native Android uses equivalent vectors. Each retains the full dietary label for assistive technology and hover text. Unknown diet labels and explicit allergens remain readable text.

Today shows one source-health warning with a direct link to Status when a check fails, data is old, or a monitored source is unchecked. A configured connection alone is never healthy. Feed freshness follows the last successful update, independently of the last attempt. Optional and shared calendar connections do not inflate the monitored total. Cloudflare instance age is labelled as instance age, without implying service uptime. Technical monitoring details stay behind disclosure.

Web source status joins Refresh and Settings in the top context controls. One status button shows View status when there is no warning, or an amber warning icon with the affected-source count when attention is needed. Unknown counts use a question mark, never a false zero. Both states open the Status destination and share the existing Settings icon-and-label control styling. Keep the full warning accessible and in Status; avoid a separate warning band or extra vertical padding. Phones abbreviate the weekday and month while retaining the date and time, and show compact control icons with the warning count. Settings keeps its heading and navigation close together. Settings tabs and recommendation outcome filters share one measured sliding underline; no full-width rail or separate active-tab borders. The indicator follows variable-width labels, remains aligned when resized or scrolled, and respects reduced motion. Auxiliary actions reuse the dashboard's transparent section controls, with visible keyboard focus and larger phone touch targets.

Status places each source name, condition, and last successful age together in a compact row. Failed attempts and freshness remain separate facts; detailed errors expand on demand. Source rows and recommendation candidates use spacing instead of repeated divider lines. Runtime, timing policy, and ranking details form quiet groups and disclosures rather than a stack of bordered panels. Preserve readable body text while increasing useful information per screen.

## Do's and Don'ts

- Lead with the backend ranking rather than a fixed class or food card.
- Keep AI output blue and label it accurately. Never use sparkle icons.
- Show the AI-highlighted posted dishes for lunch. Never substitute the first menu rows when a saved AI pick exists.
- Keep source warnings in a disclosure without filling the first screen with diagnostics.
- Avoid duplicate summaries, decorative metrics, and a dense card grid on Today.
