// Plain-language readings come from a small set of fixed, pharmacist-reviewed templates.
// They are shown *beside* the original instruction, never instead of it.
// If no template matches, we show nothing rather than guess.
const FREQ = {
  '1-0-1': 'One {u} in the morning and one at night',
  '1-0-0': 'One {u} in the morning',
  '0-0-1': 'One {u} at night',
  '0-1-0': 'One {u} in the afternoon',
  '1-1-1': 'One {u} in the morning, one in the afternoon and one at night',
  weekly: 'One {u} once a week',
};
const UNIT = { tab: 'tablet', cap: 'capsule' };
const TIMING = { 'after food': 'after food', 'before food': 'before food' };

export function plainReading(m) {
  const unit = UNIT[m.form];
  const freq = FREQ[m.frequency];
  if (!unit || !freq) return null;
  let s = freq.replace('{u}', unit);
  if (TIMING[m.timing]) s += `, ${TIMING[m.timing]}`;
  if (m.duration) s += `, for ${m.duration}`;
  return `${s}.`;
}
