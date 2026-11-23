// The structured details a Fedrok project page records. Shared by the web
// app (project page, editor), the Verda assistant (interview and edit tools)
// and the demo data. Stored on-chain as a JSON object (ProjectRegistry.details).
export const DETAIL_FIELDS = [
  { key: 'objectives', label: 'Objectives', hint: 'What the project sets out to achieve, in two or three sentences.', long: true },
  { key: 'activities', label: 'Main activities', hint: 'What will actually be done on the ground (planting, installing, training…).', long: true },
  { key: 'startDate', label: 'Start date', hint: 'When work starts or started (YYYY-MM or YYYY-MM-DD).' },
  { key: 'duration', label: 'Duration', hint: 'How long the project runs, e.g. "10 years" or "ongoing".' },
  { key: 'area', label: 'Area or scale', hint: 'Hectares, number of installations, households reached…' },
  { key: 'coordinates', label: 'GPS coordinates', hint: 'Centre point as "lat, lon" in decimal degrees, if known.' },
  { key: 'beneficiaries', label: 'Communities and beneficiaries', hint: 'Who benefits and how local people are involved.', long: true },
  { key: 'expectedImpact', label: 'Expected environmental impact', hint: 'Estimated outcomes, e.g. tonnes CO₂e avoided, hectares restored, species protected.', long: true },
  { key: 'metrics', label: 'Indicators to monitor', hint: 'What will be measured to show progress.', list: true },
  { key: 'monitoringPlan', label: 'Monitoring and reporting plan', hint: 'How, how often and by whom progress is measured and reported.', long: true },
  { key: 'methodology', label: 'Methodology or standard', hint: 'Any recognised methodology, standard or certification followed.' },
  { key: 'landTenure', label: 'Land tenure and permissions', hint: 'Who owns or manages the land and which permits or consents are in place.', long: true },
  { key: 'partners', label: 'Partners', hint: 'Organisations involved and their roles.', list: true },
  { key: 'budget', label: 'Budget and funding', hint: 'Estimated budget and where the funding comes from or is sought.', long: true },
  { key: 'risks', label: 'Risks and mitigation', hint: 'Main risks (fire, drought, permanence, social) and how they are handled.', long: true },
  { key: 'sdgs', label: 'UN Sustainable Development Goals', hint: 'Goals the project contributes to, e.g. "SDG 13 Climate action".', list: true },
  { key: 'website', label: 'Website', hint: 'Project or organisation website.' },
  { key: 'contact', label: 'Public contact', hint: 'A public contact name or role (avoid private phone numbers).' },
];

export const DETAIL_KEYS = DETAIL_FIELDS.map((f) => f.key);
export const CORE_FIELDS = [
  { key: 'name', label: 'Project name' },
  { key: 'summary', label: 'Summary' },
  { key: 'location', label: 'Location' },
  { key: 'country', label: 'Country' },
];

/** Fields still empty, used to show progress and to steer the interview. */
export function missingFields(p) {
  const out = [];
  for (const f of CORE_FIELDS) if (!String(p[f.key] || '').trim()) out.push(f.key);
  for (const f of DETAIL_FIELDS) {
    const v = p.details?.[f.key];
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) out.push(f.key);
  }
  return out;
}

export function completeness(p) {
  const total = CORE_FIELDS.length + DETAIL_FIELDS.length;
  return Math.round(((total - missingFields(p).length) / total) * 100);
}
