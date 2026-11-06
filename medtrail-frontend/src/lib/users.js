// Demo identities. In production these come from your auth provider (Supabase Auth / Clerk)
// and the backend reads the role from the verified token, never from the client.
export const USERS = [
  { id: 'u-iyer', name: 'R. Iyer', role: 'pharmacist' },
  { id: 'u-shah', name: 'A. Shah', role: 'pharmacist' },
  { id: 'u-rao', name: 'Dr. P. Rao', role: 'clinician' },
  { id: 'u-arun', name: 'Arun Kumar', role: 'patient', patientId: 'SYN-20481' },
];

// Extra simulated pharmacists used only by the Test lab race test.
export const SIM_USERS = Array.from({ length: 5 }, (_, i) => ({
  id: `sim-${i + 1}`,
  name: `Sim pharmacist ${i + 1}`,
  role: 'pharmacist',
}));

export const ROLE_LABEL = { pharmacist: 'Pharmacist', clinician: 'Clinician', patient: 'Patient' };

export const isStaff = (u) => !!u && (u.role === 'pharmacist' || u.role === 'clinician');

export function findUser(id) {
  return [...USERS, ...SIM_USERS].find((u) => u.id === id) || null;
}
