// One key per user *intent* (a click on "Resolve"), reused for every retry of that intent.
// The server stores the first response for a key and replays it for duplicates,
// so double clicks, network retries and organiser-simulated duplicates cause one effect.
export function newKey(prefix = 'req') {
  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${id}`;
}

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback for non-secure contexts (plain http on a LAN IP). Not cryptographic.
  let h = 0x811c9dc5;
  for (const b of data) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return `fnv${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export async function fileSha256(file) {
  const buf = await file.arrayBuffer();
  return sha256Hex(new Uint8Array(buf));
}
