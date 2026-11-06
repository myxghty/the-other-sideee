import { sha256Hex } from './idempotency';

// Each audit entry stores the hash of the previous one. Editing any past entry
// changes its hash and breaks every link after it, so tampering is detectable.
export function auditPayload(e) {
  return [e.prevHash, e.seq, e.at, e.actor, e.role, e.action, e.target, e.detail].join('|');
}

export function auditHash(e) {
  return sha256Hex(auditPayload(e));
}

// entries: any order. Returns how many entries verified and which seq numbers failed.
export async function verifyChain(entries) {
  const asc = [...entries].sort((a, b) => a.seq - b.seq);
  const broken = [];
  let ok = 0;
  for (let i = 0; i < asc.length; i++) {
    const e = asc[i];
    const h = await auditHash(e);
    const prev = asc[i - 1];
    const linkBroken = prev && prev.seq === e.seq - 1 && prev.hash !== e.prevHash;
    if (h !== e.hash || linkBroken) broken.push(e.seq);
    else ok++;
  }
  return { ok, broken };
}
