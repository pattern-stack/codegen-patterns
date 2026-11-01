/** Classic Levenshtein edit distance (insert / delete / substitute, cost 1). */
export function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	const dp: number[] = new Array(n + 1).fill(0).map((_, i) => i);
	for (let i = 1; i <= m; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= n; j++) {
			const tmp = dp[j];
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
			prev = tmp;
		}
	}
	return dp[n];
}
