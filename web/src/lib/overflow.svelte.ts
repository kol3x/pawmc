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
}

export interface OverflowSplit {
	/** First item index that overflows into the dropdown; null when every item fits. */
	breakIndex: number | null
}

/**
 * Splits a single-row flex strip into a visible prefix and an edge overflow dropdown.
 *
 * Contract for the caller's markup:
 * - the strip has `relative overflow-hidden` and every collapsible child carries
 *   `data-overflow-item`, hidden with `hidden` once its index reaches breakIndex;
 * - always-visible trailing controls (staging/new buttons and the dropdown wrapper)
 *   carry `data-overflow-trailing`;
 * - the dropdown wrapper renders unconditionally and toggles `invisible` when
 *   breakIndex is null, so its reserved width stays stable across measure passes.
 *
 * Measurement runs after DOM updates: breakIndex resets to null so every item
 * renders, then the first item whose right edge crosses the remaining capacity
 * (strip width minus trailing widths, gaps, and right padding) starts the
 * overflow. A ResizeObserver on the strip re-runs the split on width changes.
 */
export function createOverflowSplit(options: OverflowSplitOptions): OverflowSplit {
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
		// Measure pass: render every item, then find the first one past capacity.
		split.breakIndex = null
		tick().then(() => measure(row))
	})

	/**
	 * Computes breakIndex from the laid-out measure pass.
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

	return split
}