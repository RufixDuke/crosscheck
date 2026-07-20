/**
 * Conservative token estimator (§5.9, §13.3): `chars / 4`, deliberately
 * over-estimating so budget checks err toward refusing/truncating rather
 * than under-counting and blowing past a cost ceiling.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
