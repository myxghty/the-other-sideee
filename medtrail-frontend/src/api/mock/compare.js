// Comparison engine. In production this runs on the backend; the logic is the same.
// It only *describes* differences. It never decides which value is correct.

const FIELDS = ['strength', 'frequency', 'timing', 'route'];
const FIELD_LABEL = { strength: 'Strength', frequency: 'Timing', timing: 'Food instruction', route: 'Route' };
const DAY = 86_400_000;
const OUTDATED_AFTER_DAYS = 180;

export const FLAG_META = {
  conflict: { label: 'Conflict', tone: 'red', ticket: true },
  missing: { label: 'Missing in newer visit', tone: 'amber', ticket: true },
  outdated: { label: 'Outdated', tone: 'amber', ticket: true },
  missing_field: { label: 'Missing field', tone: 'amber', ticket: true },
  new: { label: 'New in newer visit', tone: 'blue', ticket: false },
  unchanged: { label: 'No change', tone: 'neutral', ticket: false },
};

const norm = (v) => String(v).toLowerCase().replace(/\s+/g, '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function describeMed(m) {
  if (!m) return null;
  return [m.strength, m.frequency, m.timing, m.duration].filter(Boolean).join(', ');
}

export function fmtDate(d) {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function visitSummary(v) {
  return { id: v.id, date: v.date, facility: v.facility, type: v.type, prescriber: v.prescriber, doc: v.doc };
}

export function compareVisits(db, pid, aId, bId) {
  const pv = db.visits.filter((v) => v.patientId === pid);
  let A = pv.find((v) => v.id === aId);
  let B = pv.find((v) => v.id === bId);
  if (!A || !B || A.id === B.id) return null;
  if (A.date > B.date) [A, B] = [B, A]; // A is always the older visit

  const seen = new Set();
  const order = [];
  for (const m of [...A.meds, ...B.meds]) {
    if (!seen.has(m.generic)) {
      seen.add(m.generic);
      order.push(m.generic);
    }
  }

  const rows = order.map((g) => {
    const a = A.meds.find((m) => m.generic === g) || null;
    const b = B.meds.find((m) => m.generic === g) || null;
    const flags = [];
    if (a && b) {
      const diffs = FIELDS.filter((f) => a[f] && b[f] && norm(a[f]) !== norm(b[f]));
      if (diffs.length) {
        flags.push({
          type: 'conflict',
          fields: diffs,
          label: `${diffs.map((f) => FIELD_LABEL[f]).join(' and ')} differ${diffs.length === 1 ? 's' : ''}`,
        });
      }
    } else if (a) {
      flags.push({ type: 'missing', label: 'Not listed in newer visit' });
    } else {
      flags.push({ type: 'new', label: 'First listed in newer visit' });
    }
    if (b && b.durationRequired && !b.duration) {
      flags.push({ type: 'missing_field', fields: ['duration'], label: 'Duration not written' });
    }
    if (!flags.length) flags.push({ type: 'unchanged', label: 'No change' });
    return { generic: g, display: (b || a).display, a, b, history: null, flags };
  });

  // Outdated: medicines only seen in older records, last recorded long before the newer visit.
  const older = pv.filter((v) => v.date < A.date).sort((x, y) => y.date.localeCompare(x.date));
  const lastSeen = new Map();
  for (const v of older) {
    for (const m of v.meds) {
      if (!seen.has(m.generic) && !lastSeen.has(m.generic)) lastSeen.set(m.generic, { visit: v, med: m });
    }
  }
  for (const [g, { visit, med }] of lastSeen) {
    const days = (Date.parse(B.date) - Date.parse(visit.date)) / DAY;
    if (days < OUTDATED_AFTER_DAYS) continue;
    const months = Math.round(days / 30.4);
    rows.push({
      generic: g,
      display: med.display,
      a: null,
      b: null,
      history: { visit: visitSummary(visit), med },
      flags: [{ type: 'outdated', label: `Last recorded ${fmtDate(visit.date)}, ${months} months before the newer visit` }],
    });
  }

  // A fingerprint identifies "the same discrepancy" so it becomes one ticket, however often it is sent.
  for (const r of rows) {
    for (const f of r.flags) {
      if (!FLAG_META[f.type].ticket) continue;
      f.fingerprint = [
        pid,
        r.generic,
        f.type,
        describeMed(r.a) || describeMed(r.history?.med) || '-',
        describeMed(r.b) || '-',
      ].join('|');
    }
  }

  const summary = {};
  for (const r of rows) for (const f of r.flags) summary[f.type] = (summary[f.type] || 0) + 1;

  return { patientId: pid, visitA: visitSummary(A), visitB: visitSummary(B), rows, summary };
}

function sourceOf(label, visit, med) {
  return {
    label,
    visitId: visit.id,
    facility: visit.facility,
    date: visit.date,
    type: visit.type,
    prescriber: visit.prescriber,
    docTitle: visit.doc.title,
    line: med.line,
    quote: visit.doc.lines[med.line],
    value: describeMed(med),
    display: med.display,
  };
}

export function draftTicket(cmp, row, flag, patient, now) {
  const { visitA: A, visitB: B } = cmp;
  let sources;
  let decisions;
  if (flag.type === 'conflict') {
    sources = [sourceOf('Source A', A, row.a), sourceOf('Source B', B, row.b)];
    decisions = [
      { id: 'confirm_a', label: `Confirm Source A (${A.facility}, ${fmtDate(A.date)}) as current` },
      { id: 'confirm_b', label: `Confirm Source B (${B.facility}, ${fmtDate(B.date)}) as current` },
      { id: 'clarify', label: 'Request clarification from prescriber' },
    ];
  } else if (flag.type === 'missing' || flag.type === 'outdated') {
    sources = flag.type === 'missing'
      ? [sourceOf('Source', A, row.a)]
      : [sourceOf('Source', row.history.visit, row.history.med)];
    decisions = [
      { id: 'confirm_current', label: 'Confirmed with prescriber: still current' },
      { id: 'confirm_ended', label: 'Confirmed with prescriber: no longer current' },
      { id: 'clarify', label: 'Request clarification from prescriber' },
    ];
  } else {
    sources = [sourceOf('Source', B, row.b)];
    decisions = [
      { id: 'record_as_written', label: 'Accept record as written' },
      { id: 'clarify', label: 'Request clarification from prescriber' },
    ];
  }
  return {
    fingerprint: flag.fingerprint,
    patientId: patient.id,
    patientName: patient.name,
    generic: row.generic,
    type: flag.type,
    title: `${cap(row.generic)}: ${flag.label.charAt(0).toLowerCase()}${flag.label.slice(1)}`,
    sources,
    decisions,
    status: 'open',
    claimedBy: null,
    claimExpiresAt: 0,
    version: 1,
    createdAt: now,
    history: [{ at: now, actor: 'Comparison engine', action: 'Flag raised' }],
    resolution: null,
  };
}
