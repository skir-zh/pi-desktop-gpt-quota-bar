/** Commit both views atomically; a delayed response cannot roll them back. */
export function acceptReading(current, next, sequence) {
  if (!next || next.ok === false || !next.summary || !next.snapshot
      || !Number.isFinite(next.revision)) return current;
  if (current && (next.revision < current.revision
      || (next.revision === current.revision && sequence < current.sequence))) return current;
  return { ...next, sequence };
}
