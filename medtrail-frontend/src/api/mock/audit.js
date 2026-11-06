import { auditHash } from '../../lib/hash';

// Append-only. Real backend: an INSERT-only table (no UPDATE/DELETE grants) with the same hash chain.
export async function addAudit(db, actor, action, target, detail, at = new Date().toISOString()) {
  const prev = db.audit[db.audit.length - 1];
  const e = {
    seq: (prev?.seq || 0) + 1,
    at,
    actor: actor.name,
    role: actor.role,
    action,
    target,
    detail,
    prevHash: prev?.hash || 'GENESIS',
  };
  e.hash = await auditHash(e);
  db.audit.push(e);
  return e;
}
