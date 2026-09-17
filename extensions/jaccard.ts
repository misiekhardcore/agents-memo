// Jaccard similarity over character bigrams: |A∩B| / |A∪B|. Returns a value
// in [0, 1]; 1 = identical bigram sets. Used by findMergePairs to detect
// near-duplicate bullets whose normalized keys differ but whose raw text is
// textually close (synonyms, rephrasing, pointer variations).
export function jaccard(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 && bb.size === 0) return 1;
  let intersect = 0;
  for (const g of ba) {
    if (bb.has(g)) intersect++;
  }
  const union = ba.size + bb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// Character bigrams from a normalized, space-collapsed representation.
// A single leading/trailing space is prepended/appended so word boundaries
// contribute edge bigrams (" cat " → [" c", "ca", "at", "t "]).
export function bigrams(text: string): Set<string> {
  const s = ` ${text.toLowerCase().replace(/\s+/g, " ").trim()} `;
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
