/**
 * Universal folding of AI-generated summaries for the memory panel: summaries are
 * free-form text with no guaranteed structure, so nothing here guesses at headers or
 * styles. The only split used is the deterministic lede + fold — the first paragraph
 * (extended just enough to be a meaningful preview) stays visible while the remainder
 * collapses behind a "Show more" toggle when the whole summary is too large to show
 * unfolded.
 */

/** A summary at or above this many characters is considered too large to render unfolded. */
export const SUMMARY_LARGE_CHARS = 600

/** The lede grows by appending whole paragraphs until it reaches at least this many characters. */
const LEDE_MIN_CHARS = 60

/** Hard cap for the lede; a longer paragraph is cut at the last sentence boundary within it. */
const LEDE_MAX_CHARS = 280

export type FoldedSummary =
	| { mode: "plain" }
	| { mode: "lede"; lede: string; rest: string }

/**
 * Returns the length of the longest prefix of `text` ending at a sentence boundary within
 * `max` characters, falling back to the last word boundary and then a hard cut at `max`.
 */
function sentencePrefixLength(text: string, max: number): number {
	let best = -1
	for (const match of text.matchAll(/[.!?](?=\s|$)/g)) {
		if (match.index + 1 > max) break
		best = match.index + 1
	}
	if (best > 0) return best
	const space = text.lastIndexOf(" ", max)
	if (space > 0) return space
	return Math.min(max, text.length)
}

/**
 * Extracts the visible lede: the first blank-line-delimited paragraph, extended by whole
 * paragraphs while still shorter than LEDE_MIN_CHARS. A paragraph that would push the lede
 * past LEDE_MAX_CHARS is cut at a sentence boundary; the lede text plus the source offset
 * where the folded remainder begins come back losslessly (nothing is shown twice).
 */
function extractLede(text: string): { lede: string; restFrom: number } {
	const blocks: Array<{ start: number; end: number }> = []
	let cursor = 0
	for (const match of text.matchAll(/\n[ \t]*\n/g)) {
		blocks.push({ start: cursor, end: match.index })
		cursor = match.index + match[0].length
	}
	blocks.push({ start: cursor, end: text.length })

	let lede = ""
	let restFrom = 0
	for (const block of blocks) {
		const raw = text.slice(block.start, block.end)
		const prefix = lede ? `${lede}\n\n` : ""
		if (prefix.length + raw.length > LEDE_MAX_CHARS) {
			const budget = LEDE_MAX_CHARS - prefix.length
			const cut = sentencePrefixLength(raw, budget)
			return { lede: prefix + raw.slice(0, cut), restFrom: block.start + cut }
		}
		lede = prefix + raw
		restFrom = block.end
		if (lede.length >= LEDE_MIN_CHARS) break
	}
	return { lede, restFrom }
}

/**
 * True when the summary exceeds the size threshold and should be folded rather than rendered open.
 */
export function isLargeSummary(text: string): boolean {
	return (text ?? "").length > SUMMARY_LARGE_CHARS
}

/**
 * Decides how a summary renders in the memory panel: "plain" when small, otherwise
 * "lede" — a visible opening paragraph with the remainder folded behind a toggle.
 * Independent of any formatting the generating model may or may not have used.
 */
export function foldedSummary(text: string): FoldedSummary {
	const source = text ?? ""
	if (!isLargeSummary(source)) return { mode: "plain" }
	const { lede, restFrom } = extractLede(source)
	return { mode: "lede", lede: lede.trim(), rest: source.slice(restFrom).trim() }
}
