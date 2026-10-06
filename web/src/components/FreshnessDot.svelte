<script lang="ts">
import { freshness } from "../lib/freshness"

interface Props {
	ts: number
	size?: "sm" | "md"
}

/**
 * Color-coded summary freshness dot (green < 1d, amber < 1w, orange < 1mo, gray older/never).
 */
let { ts, size = "sm" }: Props = $props()

const now = $derived(Date.now() / 1000)
const level = $derived(freshness(ts, now))
const color = $derived(
	{
		high: "bg-fresh",
		mid: "bg-aging",
		low: "bg-stale",
		none: "bg-faint/60",
	}[level],
)
const dims = $derived(size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2")

</script>
<span class="inline-block shrink-0 rounded-full {dims} {color}"></span>
