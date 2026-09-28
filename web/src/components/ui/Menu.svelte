<script lang="ts">
import type { Snippet } from "svelte"

export interface MenuItem {
	label: string
	danger?: boolean
	onpick: () => void
}

interface Props {
	label?: string
	items: MenuItem[]
	children: Snippet
}

/**
 * Click-to-open dropdown menu (kebab) with an invisible backdrop that closes it.
 */
let { label = "Menu", items, children }: Props = $props()

let open = $state(false)

function pick(item: MenuItem) {
	open = false
	item.onpick()
}

</script>
<div class="relative">
	{#if open}
		<!-- invisible full-viewport click-catcher so any outside click closes the menu -->
		<button
			class="fixed inset-0 z-40 cursor-default"
			aria-label="Close menu"
			tabindex="-1"
			onclick={() => (open = false)}
		></button>
	{/if}
	<button
		title={label}
		aria-label={label}
		onclick={() => (open = !open)}
		class="flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-panel-2 hover:text-ink"
	>
		{@render children?.()}
	</button>
	{#if open}
		<div class="absolute right-0 top-8 z-50 min-w-36 overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-xl">
			{#each items as item (item.label)}
				<button
					onclick={() => pick(item)}
					class="block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-panel-2 {item.danger
						? 'text-danger'
						: 'text-dim hover:text-ink'}"
				>
					{item.label}
				</button>
			{/each}
		</div>
	{/if}
</div>
