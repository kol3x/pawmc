<script lang="ts">
import type { Snippet } from "svelte"

export interface MenuItem {
	label: string
	danger?: boolean
	/** Marks the entry as the currently active one (accent text). */
	active?: boolean
	onpick: () => void
}

interface Props {
	label?: string
	items: MenuItem[]
	children: Snippet
}

/**
 * Click-to-open dropdown menu (kebab) with an invisible backdrop that closes it.
 * The panel is fixed-positioned from the trigger's bounding rect so ancestor
 * overflow containers (tab rows, topic chips, chat scroller) cannot clip or bury it.
 */
let { label = "Menu", items, children }: Props = $props()

let open = $state(false)
let triggerEl = $state<HTMLButtonElement | null>(null)
let panelStyle = $state("")

function placePanel() {
	const rect = triggerEl?.getBoundingClientRect()
	if (!rect) return
	panelStyle = `top: ${rect.bottom + 4}px; right: ${Math.max(0, window.innerWidth - rect.right)}px;`
}

function toggle() {
	if (!open) placePanel()
	open = !open
}

function pick(item: MenuItem) {
	open = false
	item.onpick()
}

</script>
<div>
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
		bind:this={triggerEl}
		title={label}
		aria-label={label}
		onclick={toggle}
		class="flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-panel-2 hover:text-ink"
	>
		{@render children?.()}
	</button>
	{#if open}
		<div style={panelStyle} class="fixed z-50 min-w-36 overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-xl">
			{#each items as item (item.label)}
				<button
					onclick={() => pick(item)}
class="block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-panel-2 {item.danger
					? 'text-danger'
					: item.active
						? 'text-accent'
						: 'text-dim hover:text-ink'}"
				>
					{item.label}
				</button>
			{/each}
		</div>
	{/if}
</div>
