/**
 * simulator-server presents a self-signed certificate, so the connect call has
 * to pin its SHA-256 hash. The hash reaches us as hex from `moq-info` or the
 * router, in either `AA:BB:CC` or bare `aabbcc` form.
 */
export function decodeHexFingerprint(fingerprint: string): Uint8Array {
  const cleaned = fingerprint.replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length === 0) {
    throw new Error(`Invalid MoQ certificate fingerprint (no hex digits): ${fingerprint}`);
  }
  if (cleaned.length % 2 !== 0) {
    throw new Error(`Invalid MoQ certificate fingerprint (odd hex length): ${fingerprint}`);
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
