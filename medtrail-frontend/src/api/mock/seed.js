import { addAudit } from './audit';
import { compareVisits, draftTicket } from './compare';

// All data here is synthetic.
const PATIENT = { id: 'SYN-20481', name: 'Arun Kumar', age: 58, sex: 'M', allergies: 'None recorded' };

function med(generic, display, form, line, fields) {
  return {
    generic,
    display,
    form,
    line,
    strength: null,
    frequency: null,
    timing: null,
    route: null,
    duration: null,
    durationRequired: false,
    confidence: 0.95,
    ...fields,
  };
}

function visit(id, date, facility, type, prescriber, title, lines, meds) {
  const strip = (s) => s.replace(/^\s*\d+[.)]\s*/, '');
  return {
    id,
    patientId: PATIENT.id,
    date,
    facility,
    type,
    prescriber,
    doc: { title, lines },
    meds: meds.map((m) => ({ ...m, asWritten: strip(lines[m.line]) })),
  };
}

const SYSTEM = { name: 'MedTrail extraction', role: 'system' };
const ENGINE = { name: 'Comparison engine', role: 'system' };

export async function buildSeed() {
  const visits = [
    visit('v-jan', '2026-01-18', 'City General Hospital', 'OPD prescription', 'Dr. S. Menon', 'opd-18jan.pdf', [
      'City General Hospital — OPD prescription',
      '18 Jan 2026 · Dr. S. Menon',
      'Pt: Arun Kumar · 58 M · MRN SYN-20481',
      'Rx',
      'Tab Metformin 500mg 1-0-1 A/F',
      'Inj Insulin glargine 10 units SC at night',
      'Review after 3 months',
    ], [
      med('metformin', 'Metformin 500 mg', 'tab', 4, { strength: '500 mg', frequency: '1-0-1', timing: 'after food' }),
      med('insulin glargine', 'Insulin glargine 10 units', 'inj', 5, { strength: '10 units', frequency: '0-0-1', route: 'SC', confidence: 0.89 }),
    ]),
    visit('v-jun', '2026-06-03', 'Sunrise Pharmacy', 'Dispense record', '—', 'dispense-03jun.pdf', [
      'Sunrise Pharmacy — Dispense record',
      '03 Jun 2026 · Patient: Arun Kumar',
      'Metformin 500 mg tab × 60',
      'Amlodipine 5 mg tab × 30',
      'Atorvastatin 20 mg tab × 30',
    ], [
      med('metformin', 'Metformin 500 mg', 'tab', 2, { strength: '500 mg', confidence: 0.98 }),
      med('amlodipine', 'Amlodipine 5 mg', 'tab', 3, { strength: '5 mg', confidence: 0.98 }),
      med('atorvastatin', 'Atorvastatin 20 mg', 'tab', 4, { strength: '20 mg', confidence: 0.98 }),
    ]),
    visit('v-aug', '2026-08-12', 'City General Hospital', 'Discharge summary', 'Dr. S. Menon', 'discharge-12aug.pdf', [
      'City General Hospital — Discharge summary',
      '12 Aug 2026 · Dr. S. Menon',
      'Pt: Arun Kumar · 58 M · MRN SYN-20481',
      'Medications on discharge:',
      '1. Tab Metformin 500mg BD A/F',
      '2. Tab Amlodipine 5mg OD morning',
      '3. Tab Atorvastatin 20mg HS',
      '4. Tab Aspirin 75mg after lunch',
      '5. Tab Pantoprazole 40mg OD B/F × 14 days',
    ], [
      med('metformin', 'Metformin 500 mg', 'tab', 4, { strength: '500 mg', frequency: '1-0-1', timing: 'after food' }),
      med('amlodipine', 'Amlodipine 5 mg', 'tab', 5, { strength: '5 mg', frequency: '1-0-0' }),
      med('atorvastatin', 'Atorvastatin 20 mg', 'tab', 6, { strength: '20 mg', frequency: '0-0-1' }),
      med('aspirin', 'Aspirin 75 mg', 'tab', 7, { strength: '75 mg', frequency: '0-1-0', timing: 'after food' }),
      med('pantoprazole', 'Pantoprazole 40 mg', 'tab', 8, { strength: '40 mg', frequency: 'once daily', timing: 'before food', duration: '14 days' }),
    ]),
    visit('v-oct', '2026-10-28', 'Green Valley Clinic', 'OPD prescription', 'Dr. P. Rao', 'opd-28oct.jpg', [
      'Green Valley Clinic — OPD',
      '28 Oct 2026 · Dr. P. Rao',
      'Pt: Arun Kumar · Age 58',
      'Rx',
      '1) Tab Metformin 1000mg 1-0-1 A/F',
      '2) Tab Atorvastatin 20mg 0-0-1',
      '3) Tab Amlodipine 5mg 0-0-1',
      '4) Tab Aspirin 75mg 0-1-0',
      '5) Cap Vitamin D3 60000 IU once weekly',
    ], [
      med('metformin', 'Metformin 1000 mg', 'tab', 4, { strength: '1000 mg', frequency: '1-0-1', timing: 'after food', confidence: 0.94 }),
      med('atorvastatin', 'Atorvastatin 20 mg', 'tab', 5, { strength: '20 mg', frequency: '0-0-1' }),
      med('amlodipine', 'Amlodipine 5 mg', 'tab', 6, { strength: '5 mg', frequency: '0-0-1', confidence: 0.92 }),
      med('aspirin', 'Aspirin 75 mg', 'tab', 7, { strength: '75 mg', frequency: '0-1-0' }),
      med('vitamin d3', 'Vitamin D3 60,000 IU', 'cap', 8, { strength: '60,000 IU', frequency: 'weekly', durationRequired: true, confidence: 0.91 }),
    ]),
  ];

  const db = {
    schema: 1,
    seq: 115,
    patients: { [PATIENT.id]: PATIENT },
    visits,
    tickets: [],
    audit: [],
    idem: {},
    uploads: [],
    handovers: [],
  };

  // Audit history for the documents already on file.
  for (const v of visits) {
    await addAudit(db, { name: 'Arun Kumar', role: 'patient' }, 'DOCUMENT_UPLOADED', v.doc.title, `${v.type}, ${v.facility}`, `${v.date}T09:30:00.000Z`);
    await addAudit(db, SYSTEM, 'VALUES_EXTRACTED', v.doc.title, `${v.meds.length} medicines extracted and linked to source lines`, `${v.date}T09:31:00.000Z`);
  }

  const now = Date.now();
  const hoursAgo = (h) => new Date(now - h * 3_600_000).toISOString();

  // Tickets already raised for Arun (the remaining flags are left for "Send flags to review").
  const cmp = compareVisits(db, PATIENT.id, 'v-aug', 'v-oct');
  let n = 113;
  for (const row of cmp.rows) {
    for (const f of row.flags) {
      if (f.type !== 'conflict') continue;
      const t = draftTicket(cmp, row, f, PATIENT, hoursAgo(2));
      t.id = `RQ-${n++}`;
      db.tickets.push(t);
      await addAudit(db, ENGINE, 'FLAG_RAISED', t.id, t.title, hoursAgo(2));
    }
  }

  // Tickets for other synthetic patients.
  db.tickets.push({
    id: 'RQ-109',
    fingerprint: 'SYN-19877|levothyroxine|missing_field|-|50 mcg, 1-0-0',
    patientId: 'SYN-19877',
    patientName: 'Meena S.',
    generic: 'levothyroxine',
    type: 'missing_field',
    title: 'Levothyroxine: duration not written',
    sources: [{ label: 'Source', visitId: 'x', facility: 'Lakeview Clinic', date: '2026-11-02', type: 'OPD prescription', prescriber: 'Dr. K. Iqbal', docTitle: 'opd-02nov.jpg', line: 4, quote: 'Tab Levothyroxine 50mcg 1-0-0 empty stomach', value: '50 mcg, 1-0-0', display: 'Levothyroxine 50 mcg' }],
    decisions: [
      { id: 'record_as_written', label: 'Accept record as written' },
      { id: 'clarify', label: 'Request clarification from prescriber' },
    ],
    status: 'open', claimedBy: null, claimExpiresAt: 0, version: 1, createdAt: hoursAgo(26),
    history: [{ at: hoursAgo(26), actor: 'Comparison engine', action: 'Flag raised' }], resolution: null,
  });
  db.tickets.push({
    id: 'RQ-104',
    fingerprint: 'SYN-18302|insulin aspart|outdated|8 units, 1-1-1|-',
    patientId: 'SYN-18302',
    patientName: 'Joseph D.',
    generic: 'insulin aspart',
    type: 'outdated',
    title: 'Insulin aspart: last recorded 9 months ago',
    sources: [{ label: 'Source', visitId: 'y', facility: 'City General Hospital', date: '2026-02-06', type: 'Discharge summary', prescriber: 'Dr. S. Menon', docTitle: 'discharge-06feb.pdf', line: 6, quote: 'Inj Insulin aspart 8 units SC before meals', value: '8 units, 1-1-1', display: 'Insulin aspart 8 units' }],
    decisions: [
      { id: 'confirm_current', label: 'Confirmed with prescriber: still current' },
      { id: 'confirm_ended', label: 'Confirmed with prescriber: no longer current' },
      { id: 'clarify', label: 'Request clarification from prescriber' },
    ],
    status: 'open', claimedBy: null, claimExpiresAt: 0, version: 1, createdAt: hoursAgo(70),
    history: [{ at: hoursAgo(70), actor: 'Comparison engine', action: 'Flag raised' }], resolution: null,
  });

  return db;
}
