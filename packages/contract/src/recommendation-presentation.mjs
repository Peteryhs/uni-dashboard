/** Compact uncertainty signals; also handles recommendations cached before these fields existed. */
export const RECOMMENDATION_WARNINGS = Object.freeze({
  time_unknown: { label: 'Time unknown', detail: 'Exact time not supplied. Check course instructions.' },
  coverage_unknown: { label: 'Coverage unknown', detail: 'Assessment coverage not supplied. Check course instructions.' },
  submission_unknown: { label: 'Submission unknown', detail: 'The listed deadline has passed. Check whether you submitted this.' },
  completion_unknown: { label: 'Completion unknown', detail: 'The listed assessment time has passed. Check whether you completed this.' },
});

const legacyWarnings = [
  ['time_unknown', /; no exact time was supplied\. Check the course instructions\./g, '.'],
  ['coverage_unknown', /\s*Coverage has not been provided; check the course instructions\./g, ''],
  ['submission_unknown', /; submission status is unknown\./g, '.'],
  ['completion_unknown', /; completion status is unknown\./g, '.'],
];

export function recommendationPresentation(item) {
  const warnings = new Set((item.warnings || []).filter(code => Object.hasOwn(RECOMMENDATION_WARNINGS, code)));
  let body = item.body || '';
  if (item.kind === 'task') {
    for (const [code, pattern, replacement] of legacyWarnings) {
      body = body.replace(pattern, () => { warnings.add(code); return replacement; });
    }
  }
  return { body: body.trim(), warnings: [...warnings] };
}
