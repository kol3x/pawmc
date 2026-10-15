import { tick } from "svelte"

export interface OverflowSplitOptions {
	/** Reactive reads that should re-run the split (loaded lists, staged names, toggles). */
	deps: () => unknown
	/** The strip element; the caller binds it with bind:this and marks it `relative`. */
	row: () => HTMLElement | null
	/** The overflow-control wrapper; the caller binds it with bind:this and renders it unconditionally. */
	more: () => HTMLElement | null
	/** Flex gap of the strip in px, counted between trailing controls. */
	gapPx: number
	/** Rows a wrapping strip may use before items collapse into the extension; 1 keeps the single-row split. */
	maxRows?: number
}

export interface OverflowSplit {
	/** First item index that overflows into the dropdown; null when every item fits. */
	breakIndex: number | null
}

/**
 * Splits a flex strip into a visible prefix and an edge overflow extension.
 *
 * Single-row mode (maxRows 1, the default): the strip is a one-line flex row; the first item
 * whose right edge crosses the remaining capacity (strip width minus trailing widths, gaps,
 * and right padding) starts the overflow.
 *
 * Wrap mode (maxRows > 1): the strip is a flex-wrap strip allowed up to that many rows; items
 * laid out beyond the row limit are hidden into the extension. Rows are detected by grouping
 * offsetTop values with a tolerance (items in one row differ by a few px through centering).
 *
 * Shared contract for the caller's markup:
 * - every collapsible child carries `data-overflow-item`, hidden with `hidden` once its index
 *   reaches breakIndex;
 * - always-visible trailing controls (staging/new buttons and the overflow-toggle wrapper)
 *   carry `data-overflow-trailing`;
 * - the toggle wrapper renders unconditionally and toggles `invisible` when breakIndex is
 *   null, so its reserved width stays stable across measure passes.
 *
 * Measurement runs after DOM updates. Wrap mode iterates hide-then-remeasure passes until the
 * strip fits; every pass stays inside one task (awaiting only microtasks), so the browser
 * paints the final layout and intermediate over-lined states never reach the screen. A
 * ResizeObserver on the strip re-runs the split on size changes.
 */
export function createOverflowSplit(options: OverflowSplitOptions): OverflowSplit {
	const maxRows = options.maxRows ?? 1
	const split = $state<OverflowSplit>({ breakIndex: null })
	let epoch = $state(0)

	// Track the strip's box so window and flex resizes re-run the split.
	$effect(() => {
		const row = options.row()
		if (!row) return
		const observer = new ResizeObserver(() => {
			epoch++
		})
		observer.observe(row)
		return () => observer.disconnect()
	})

	$effect(() => {
		options.deps()
		void epoch
		const row = options.row()
		const more = options.more()
		if (!row || !more) return
		if (maxRows > 1) {
			void measureWrap(row)
			return
		}
		// Measure pass: render every item, then find the first one past capacity.
		split.breakIndex = null
		tick().then(() => measure(row))
	})

	/**
	 * Computes breakIndex from the laid-out measure pass (single-row mode).
	 */
	function measure(row: HTMLElement) {
		const items = Array.from(row.querySelectorAll<HTMLElement>("[data-overflow-item]"))
		if (items.length === 0) {
			split.breakIndex = null
			return
		}
		const trailing = Array.from(row.querySelectorAll<HTMLElement>("[data-overflow-trailing]"))
		const padRight = Number.parseFloat(getComputedStyle(row).paddingRight) || 0
		const trailWidth =
			trailing.reduce((sum, el) => sum + el.offsetWidth, 0) + options.gapPx * trailing.length
		const cap = row.clientWidth - padRight - trailWidth
		let index: number | null = null
		for (let i = 0; i < items.length; i++) {
			const item = items[i]
			if (item && item.offsetLeft + item.offsetWidth > cap) {
				index = i
				break
			}
		}
		split.breakIndex = index
	}

	/** Tops of distinct laid-out rows: offsetTop values grouped with an intra-row jitter tolerance. */
	function rowTops(elements: HTMLElement[]): number[] {
		const sorted = elements.map((el) => el.offsetTop).sort((a, b) => a - b)
		const tops: number[] = []
		for (const top of sorted) {
			if (tops.length === 0 || top - tops[tops.length - 1] > 8) tops.push(top)
		}
		return tops
	}

	/**
	 * Computes breakIndex for a flex-wrap strip (maxRows > 1): hides items laid out beyond the
	 * row limit, remeasuring after each hide until the strip fits within maxRows rows.
	 */
	async function measureWrap(row: HTMLElement) {
		const items = Array.from(row.querySelectorAll<HTMLElement>("[data-overflow-item]"))
		const trailing = Array.from(row.querySelectorAll<HTMLElement>("[data-overflow-trailing]"))
		if (items.length === 0) {
			split.breakIndex = null
			return
		}
		let index: number | null = null
		for (let guard = 0; guard <= items.length; guard++) {
			split.breakIndex = index
			await tick()
			const visible = items.slice(0, index ?? items.length)
			const tops = rowTops([...visible, ...trailing])
			if (tops.length <= maxRows) return
			const limitTop = tops[maxRows]
			const first = visible.findIndex((el) => el.offsetTop >= limitTop)
			if (first >= 0) {
				index = first
				continue
			}
			// Items fit but a trailing control wrapped past the limit: drop the last item.
			if (visible.length === 0) return
			index = visible.length - 1
		}
	}

	return split
}
