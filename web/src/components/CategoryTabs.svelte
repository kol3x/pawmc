<script lang="ts">
import { app } from "../lib/appState.svelte"
import type { CategorySummary } from "../api"
import FreshnessDot from "./FreshnessDot.svelte"
import Menu from "./Menu.svelte"
import { createOverflowSplit } from "../lib/overflow.svelte"

interface Props {
	onrenamecategory: (cat: CategorySummary) => void
	ondeletecategory: (cat: CategorySummary) => void
}

/**
 * Diary tab strip: diaries are the base of the interface — always visible and
 * selectable, with tabs past the strip's width collapsing into an edge overflow
 * dropdown. The plus chip reveals an inline name input; Enter stages a ghost tab
 * (dashed, not yet saved) that becomes real when the first message is sent.
 * The active diary is pinned to the front so it never hides behind the dropdown.
 */
let { onrenamecategory, ondeletecategory }: Props = $props()

let creating = $state(false)
let newName = $state("")
let newInputEl = $state<HTMLInputElement | null>(null)

let rowEl = $state<HTMLElement | null>(null)
let moreEl = $state<HTMLElement | null>(null)

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

// Selected diary first so its rename/delete kebab stays reachable when the strip overflows.
const orderedCategories = $derived.by(() => {
	const cats = app.categories ?? []
	const selected = cats.find((c) => c.id === app.categoryId)
	return selected ? [selected, ...cats.filter((c) => c !== selected)] : cats
})

const overflow = createOverflowSplit({
	deps: () => {
		void orderedCategories
		void app.pendingCategoryName
		void creating
	},
	row: () => rowEl,
	more: () => moreEl,
	gapPx: 4,
})

const moreItems = $derived.by(() => {
	if (overflow.breakIndex === null) return []
	return orderedCategories
		.slice(overflow.breakIndex)
		.map((cat) => ({
			label: cat.name,
			active: app.categoryId === cat.id,
			onpick: () => app.selectCategory(cat.id),
		}))
})
</script>
<div
	bind:this={rowEl}
	class="relative flex items-center gap-1 overflow-hidden px-2"
	role="tablist"
	aria-label="Diaries"
>
	{#if app.categories === null}
		<div class="px-2 py-2 text-xs text-faint">Loading…</div>
	{:else}
		{#each orderedCategories as cat, i (cat.id)}
			<div
				data-overflow-item
				class="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 transition-colors {app.categoryId === cat.id
					? 'bg-accent-soft text-accent'
					: 'text-dim hover:bg-panel-2 hover:text-ink'} {overflow.breakIndex !== null && i >= overflow.breakIndex ? 'hidden' : ''}"
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
					label="Diary actions"
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
			data-overflow-trailing
			class="flex shrink-0 items-center gap-1.5 rounded-lg border border-dashed border-accent/60 px-2.5 py-1.5 text-sm font-medium text-accent"
			title="Not saved yet — this diary starts with your first message"
		>
			<span class="max-w-28 truncate italic sm:max-w-40">{app.pendingCategoryName}</span>
			<button
				class="text-faint transition-colors hover:text-danger"
				onclick={() => app.cancelPendingCategory()}
				title="Discard new diary"
				aria-label="Discard new diary"
			>
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
			</button>
		</div>
	{/if}
	{#if creating}
		<input
			data-overflow-trailing
			placeholder="Diary name — Enter"
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
			class="h-8 w-28 shrink-0 rounded-lg border border-accent/50 bg-bg px-2.5 text-sm placeholder:text-faint focus:border-accent focus:outline-none sm:w-40"
		/>
	{:else if !app.pendingCategoryName}
		<button
			data-overflow-trailing
			class="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-faint transition-colors hover:bg-panel-2 hover:text-ink"
			onclick={() => (creating = true)}
			title="New diary"
		>
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
			New
		</button>
	{/if}
	<div
		bind:this={moreEl}
		data-overflow-trailing
		class="shrink-0 {overflow.breakIndex === null ? 'invisible' : ''}"
	>
		<Menu label="More diaries" items={moreItems}>
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
		</Menu>
	</div>
</div>