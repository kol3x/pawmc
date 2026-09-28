/**
 * Structural parsing of AI-generated summaries for the memory panel: summaries are
 * typically written as repeated "**Header**" lines followed by body text, which the
 * panel folds into collapsible sections when the whole summary is too large to show open.
 */

export interface SummarySection {
	/** Header text without the bold markers, or null for the preamble before the first header. */
	header: string | null
	/** Raw markdown body lines belonging to this section. */
	body: string
}

export type SummaryRenderMode = "plain" | "accordion" | "spoiler"

export interface FoldedSummary {
	mode: SummaryRenderMode
	/** Sections for "accordion" mode: preamble (header null) first when present, then headered sections. */
	sections: SummarySection[]
}

/** A summary at or above this many characters is considered too large to render unfolded. */
export const SUMMARY_LARGE_CHARS = 600

/** A line that is exactly a bold header (optionally bullet-prefixed, colon-terminated) with no trailing text. */
const BOLD_HEADER_LINE = /^\s*(?:[-*]\s+)?\*\*(.+?)\*\*\s*:?\s*$/

/** A line that starts with a bold header and carries the first body text on the same line. */
const BOLD_HEADER_LEAD = /^\s*(?:[-*]\s+)?\*\*(.+?)\*\*\s*:?\s+(.+)$/

/**
 * Normalizes a captured header: drops a trailing colon and surrounding whitespace.
 */
function cleanHeader(raw: string): string {
	return raw.replace(/:\s*$/, "").trim()
}

/**
 * Splits a summary into sections on bold headers in two shapes: standalone "**Header**"
 * lines (body follows on later lines) and inline "**Header:** text" lead-ins (the rest of
 * the line starts the body, later lines continue it). Text before the first header becomes
 * a preamble section with a null header; summaries without any header come back as a single
 * null-header section holding the whole text.
 */
export function splitSummarySections(text: string): SummarySection[] {
	const sections: SummarySection[] = []
	let current: SummarySection = { header: null, body: "" }
	const push = () => {
		if (current.body.trim() || current.header !== null) sections.push(current)
	}
	for (const line of (text ?? "").split("\n")) {
		const standalone = BOLD_HEADER_LINE.exec(line)
		const lead = standalone ? null : BOLD_HEADER_LEAD.exec(line)
		if (standalone) {
			push()
			current = { header: cleanHeader(standalone[1]), body: "" }
		} else if (lead) {
			push()
			current = { header: cleanHeader(lead[1]), body: lead[2] }
		} else {
			current.body += (current.body ? "\n" : "") + line
		}
	}
	push()
	return sections
}

/**
 * True when the summary exceeds the size threshold and should be folded rather than rendered open.
 */
export function isLargeSummary(text: string): boolean {
	return (text ?? "").length > SUMMARY_LARGE_CHARS
}

/**
 * Decides how a summary renders in the memory panel: "plain" when small or empty,
 * "accordion" when large and split into at least two headered sections, "spoiler"
 * as the fallback for large summaries without header structure. The preamble (text
 * before the first header) is always kept visible by the caller in accordion mode.
 */
export function foldedSummary(text: string): FoldedSummary {
	const sections = splitSummarySections(text)
	if (!isLargeSummary(text)) return { mode: "plain", sections }
	const headered = sections.filter((s) => s.header !== null)
	if (headered.length >= 2) return { mode: "accordion", sections }
	return { mode: "spoiler", sections }
}
