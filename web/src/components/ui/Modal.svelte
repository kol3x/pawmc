<script lang="ts">
import type { Snippet } from "svelte"

interface Props {
	title: string
	open?: boolean
	onclose: () => void
	maxWidth?: string
	children: Snippet
}

/**
 * Backdrop modal with an Escape handler and outside-click close.
 */
let {
	title,
	open = false,
	onclose,
	maxWidth = "max-w-md",
	children,
}: Props = $props()

$effect(() => {
	if (!open) return
	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape") onclose()
	}
	window.addEventListener("keydown", onKey)
	return () => window.removeEventListener("keydown", onKey)
})

</script>
{#if open}
	<div class="fixed inset-0 z-50 flex items-center justify-center p-4">
		<button
			class="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
			aria-label="Close"
			tabindex="-1"
			onclick={onclose}
		></button>
		<div class="relative flex w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl {maxWidth}" role="dialog" aria-modal="true" aria-label={title}>
			<div class="flex items-center justify-between border-b border-line px-4 py-3">
				<h2 class="text-sm font-semibold">{title}</h2>
				<button
					class="flex h-7 w-7 items-center justify-center rounded-md text-dim hover:bg-panel-2 hover:text-ink"
					onclick={onclose}
					aria-label="Close"
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
				</button>
			</div>
			<div class="p-4">
				{@render children?.()}
			</div>
		</div>
	</div>
{/if}
