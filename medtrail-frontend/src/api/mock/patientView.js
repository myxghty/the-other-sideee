import { plainReading } from '../../lib/plain';
import { compareVisits } from './compare';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function item(med, visit, status, resolution) {
  return {
    generic: med.generic,
    title: med.display,
    status, // 'verified' | 'consistent'
    asWritten: med.asWritten, // verbatim from the source document
    plain: plainReading(med),
    source: { facility: visit.facility, date: visit.date, docTitle: visit.doc.title, line: med.line + 1 },
    verifiedBy: resolution ? resolution.by.name : null,
    verifiedAt: resolution ? resolution.at : null,
  };
}

// Patients only ever see (a) instructions a pharmacist verified, (b) instructions that match
// across their last two records, or (c) a neutral "being reviewed" notice. No advice is generated.
export function buildPatientView(db, pid) {
  const pv = db.visits.filter((v) => v.patientId === pid).sort((x, y) => y.date.localeCompare(x.date));
  if (pv.length < 2) return { patientId: pid, items: [] };
  const cmp = compareVisits(db, pid, pv[1].id, pv[0].id);
  const items = [];

  for (const row of cmp.rows) {
    const flags = row.flags.filter((f) => f.fingerprint);
    if (!flags.length) {
      if (row.b) items.push(item(row.b, cmp.visitB, 'consistent'));
      continue;
    }
    const tickets = flags.map((f) => db.tickets.find((t) => t.fingerprint === f.fingerprint) || null);
    if (tickets.some((t) => !t || t.status !== 'resolved')) {
      items.push({
        generic: row.generic,
        title: cap(row.generic),
        status: 'in_review',
        message:
          'Your records show different information for this medicine. A pharmacist is checking. Keep following your doctor’s advice and ask them if you are unsure.',
      });
      continue;
    }
    let chosen = null;
    let resolution = null;
    for (const t of tickets) {
      const d = t.resolution.decision;
      resolution = t.resolution;
      if (d === 'confirm_ended') {
        chosen = 'ended';
        break;
      }
      if (d === 'confirm_a') chosen = { med: row.a, visit: cmp.visitA };
      else if (d === 'confirm_current') {
        chosen = row.a ? { med: row.a, visit: cmp.visitA } : { med: row.history.med, visit: row.history.visit };
      } else if ((d === 'confirm_b' || d === 'record_as_written') && !chosen) {
        chosen = { med: row.b, visit: cmp.visitB };
      }
    }
    if (!chosen || chosen === 'ended') continue;
    items.push(item(chosen.med, chosen.visit, 'verified', resolution));
  }

  const order = { in_review: 0, verified: 1, consistent: 2 };
  items.sort((x, y) => order[x.status] - order[y.status]);
  return { patientId: pid, generatedAt: new Date().toISOString(), items };
}
