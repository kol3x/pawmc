export type Freshness = "high" | "mid" | "low" | "none"

/**
 * Buckets a summary timestamp into a freshness level for color-coding.
 */
export function freshness(ts: number, now: number = Date.now() / 1000): Freshness {
	if (!ts) return "none"
	const age = now - ts
	if (age < 86400) return "high"
	if (age < 86400 * 7) return "mid"
	if (age < 86400 * 30) return "low"
	return "none"
}

/**
 * Human-readable relative age of a unix-seconds timestamp.
 */
export function relativeTime(ts: number, now: number = Date.now() / 1000): string {
	if (!ts) return "never"
	const age = now - ts
	if (age < 60) return "just now"
	if (age < 3600) return `${Math.floor(age / 60)}m ago`
	if (age < 86400) return `${Math.floor(age / 3600)}h ago`
	if (age < 86400 * 30) return `${Math.floor(age / 86400)}d ago`
	return new Date(ts * 1000).toLocaleDateString()
}
