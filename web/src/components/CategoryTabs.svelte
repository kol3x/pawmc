<script lang="ts">
import { app } from "../lib/appState.svelte"
import type { CategorySummary } from "../api-types"
import FreshnessDot from "./FreshnessDot.svelte"
import Menu from "./ui/Menu.svelte"

interface Props {
	onrenamecategory: (cat: CategorySummary) => void
	ondeletecategory: (cat: CategorySummary) => void
}

/**
 * Category tab bar: categories are the base of the interface — always visible and
 * selectable. The plus chip reveals an inline name input; Enter stages a ghost tab
 * (dashed, not yet saved) that becomes real when the first message is sent.
 */
let { onrenamecategory, ondeletecategory }: Props = $props()

let creating = $state(false)
let newName = $state("")
let newInputEl = $state<HTMLInputElement | null>(null)

$effect(() => {
	if (creating) newInputEl?.focus()
})

function submitNew() {
	const name = newName.trim()
	creating = false
	newName = ""
	if (name) app.stageNewCategory(name)
}

function cancelNew() {
	creating = false
	newName = ""
}
</script>
<div class="flex items-center gap-1 overflow-x-auto px-2" role="tablist" aria-label="Categories">
	{#if app.categories === null}
		<div class="px-2 py-2 text-xs text-faint">Loading…</div>
	{:else}
		{#each app.categories as cat (cat.id)}
			<div
				class="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 transition-colors {app.categoryId === cat.id
					? 'bg-accent-soft text-accent'
					: 'text-dim hover:bg-panel-2 hover:text-ink'}"
			>
				<button
					class="flex items-center gap-1.5 text-sm font-medium"
					onclick={() => app.selectCategory(cat.id)}
					title={cat.name}
					role="tab"
					aria-selected={app.categoryId === cat.id}
				>
					{cat.name}
					<FreshnessDot ts={cat.updated_at_timestamp} />
				</button>
				<Menu
					label="Category actions"
					items={[
						{ label: "Rename", onpick: () => onrenamecategory(cat) },
						{ label: "Delete", danger: true, onpick: () => ondeletecategory(cat) },
					]}
				>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
				</Menu>
			</div>
		{/each}
	{/if}
	{#if app.pendingCategoryName}
		<div
			class="flex shrink-0 items-center gap-1.5 rounded-lg border border-dashed border-accent/60 px-2.5 py-1.5 text-sm font-medium text-accent"
			title="Not saved yet — this category becomes real with your first message"
		>
			<span class="max-w-40 truncate italic">{app.pendingCategoryName}</span>
			<button
				class="text-faint transition-colors hover:text-danger"
				onclick={() => app.cancelPendingCategory()}
				title="Discard new category"
				aria-label="Discard new category"
			>
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
			</button>
		</div>
	{/if}
	{#if creating}
		<input
			placeholder="Category name — Enter"
			bind:value={newName}
			bind:this={newInputEl}
			onkeydown={(e) => {
				if (e.key === "Enter") {
					e.preventDefault()
					submitNew()
				} else if (e.key === "Escape") {
					e.preventDefault()
					cancelNew()
				}
			}}
			onblur={() => creating && newName.trim() === "" && cancelNew()}
			class="h-8 w-40 shrink-0 rounded-lg border border-accent/50 bg-bg px-2.5 text-sm placeholder:text-faint focus:border-accent focus:outline-none"
		/>
	{:else}
		<button
			class="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-faint transition-colors hover:bg-panel-2 hover:text-ink"
			onclick={() => (creating = true)}
			title="New category"
		>
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
			New
		</button>
	{/if}
</div>