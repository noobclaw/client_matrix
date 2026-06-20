/**
 * MMR (Maximal Marginal Relevance) — re-ranks search results for diversity.
 * Prevents returning multiple memories that say essentially the same thing.
 *
 * Reference: OpenClaw src/memory/mmr.ts
 *
 * Algorithm: For each candidate, score = λ * relevance - (1-λ) * maxSimilarity(to already selected)
 * λ = 0.7 means 70% relevance, 30% diversity
 */

export interface MMRCandidate {
  id: string;
  text: string;
  score: number;  // Original relevance score [0, 1]
}

/**
 * Tokenize text into word set for Jaccard similarity.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
  );
}

/**
 * Jaccard similarity between two token sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Apply MMR re-ranking to a list of search results.
 *
 * @param candidates - Search results with scores
 * @param limit - Max results to return
 * @param lambda - Balance: 1.0 = pure relevance, 0.0 = pure diversity (default: 0.7)
 * @returns Re-ranked results with diversity
 */
export function applyMMR(
  candidates: MMRCandidate[],
  limit: number,
  lambda: number = 0.7
): MMRCandidate[] {
  if (candidates.length <= 1) return candidates.slice(0, limit);

  // Normalize scores to [0, 1]
  const maxScore = Math.max(...candidates.map(c => c.score));
  const minScore = Math.min(...candidates.map(c => c.score));
  const range = maxScore - minScore || 1;
  const normalized = candidates.map(c => ({
    ...c,
    normalizedScore: (c.score - minScore) / range,
    tokens: tokenize(c.text),
  }));

  const selected: (typeof normalized[0])[] = [];
  const remaining = new Set(normalized.map((_, i) => i));

  // Greedily select candidates
  for (let step = 0; step < limit && remaining.size > 0; step++) {
    let bestIdx = -1;
    let bestMMRScore = -Infinity;

    for (const idx of remaining) {
      const candidate = normalized[idx];
      const relevance = candidate.normalizedScore;

      // Max similarity to any already-selected result
      let maxSim = 0;
      for (const sel of selected) {
        const sim = jaccardSimilarity(candidate.tokens, sel.tokens);
        if (sim > maxSim) maxSim = sim;
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;

      if (mmrScore > bestMMRScore) {
        bestMMRScore = mmrScore;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(normalized[bestIdx]);
      remaining.delete(bestIdx);
    }
  }

  return selected.map(s => ({ id: s.id, text: s.text, score: s.score }));
}
