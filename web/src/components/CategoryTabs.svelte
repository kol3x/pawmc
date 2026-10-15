<script lang="ts">
import { tick } from "svelte"
import { app } from "../lib/appState.svelte"
import { ui } from "../lib/uiState.svelte"
import type { CategorySummary } from "../api"
import FreshnessDot from "./FreshnessDot.svelte"
import Menu from "./Menu.svelte"
import { createOverflowSplit } from "../lib/overflow.svelte"
import { freshnessOrderWithSelected } from "../lib/freshness"

interface Props {
	/** Opens the shared prompt modal to name a new diary; staging happens on submit. */
	onnewcategory: () => void
	onrenamecategory: (cat: CategorySummary) => void
	ondeletecategory: (cat: CategorySummary) => void
}

/**
 * Diary tab strip: diaries are the base of the interface — always visible and selectable,
 * single row, ordered most recently updated first (summary freshness) with the active diary
 * pinned to the front. On mobile only the active tab keeps its kebab and drops its freshness
 * dot; the extension panel carries kebabs for every entry. Tabs past the row's
 * width collapse behind an edge chevron that expands an extension panel below the strip: the
 * same full tabs (rename/delete kebab on every entry, freshness dot on non-selected ones), a
 * search input filtering the extension by name, and a "New diary" action that opens the shared
 * prompt modal — naming a diary never happens in place. Submitting stages a dashed ghost tab
 * that becomes real when the first message is sent. The chevron stays available even when
 * nothing overflows, so the diary list and creation are always reachable.
 */
let { onnewcategory, onrenamecategory, ondeletecategory }: Props = $props()

let rowEl = $state<HTMLElement | null>(null)
let moreEl = $state<HTMLElement | null>(null)
let searchEl = $state<HTMLInputElement | null>(null)
let extendedOpen = $state(false)
let search = $state("")

// Selected diary first so its rename/delete kebab stays reachable when the row overflows;
// otherwise most recently updated first, matching the topic chips' freshness order.
const orderedCategories = $derived.by(() =>
	freshnessOrderWithSelected(app.categories ?? [], app.categoryId),
)

const overflow = createOverflowSplit({
	deps: () => {
		void orderedCategories
		void app.pendingCategoryName
	},
	row: () => rowEl,
	more: () => moreEl,
	gapPx: 4,
	maxRows: 1,
})

// Extension contents: the diaries the strip row could not fit — or, when nothing overflows,
// the full list. The search narrows the slice by name; visible strip tabs are never filtered.
const extendedCategories = $derived.by(() => {
	const slice = orderedCategories.slice(overflow.breakIndex ?? 0)
	const q = search.trim().toLowerCase()
	if (!q) return slice
	return slice.filter((cat) => cat.name.toLowerCase().includes(q))
})

function toggleExtended() {
	if (extendedOpen) {
		closeExtended()
		return
	}
	extendedOpen = true
	// Desktop only: focusing the search on mobile would pop the keyboard unprompted.
	if (window.matchMedia("(min-width: 768px)").matches) tick().then(() => searchEl?.focus())
}

/** Closes the extension and clears the search so the next open starts fresh. */
function closeExtended() {
	extendedOpen = false
	search = ""
}

function pick(cat: CategorySummary) {
	app.selectCategory(cat.id)
	closeExtended()
}

/** Closes the extension, then hands off to the shared prompt modal for the new diary's name. */
function requestNew() {
	closeExtended()
	onnewcategory()
}
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && extendedOpen && closeExtended()} />

{#snippet chip(cat: CategorySummary, hidden = false, withMenu = false)}
	<div
		data-overflow-item
		class="flex shrink-0 items-center gap-1 rounded-lg py-1.5 transition-colors {withMenu && ui.canMutate ? 'pr-1' : 'pr-2.5'} {app.categoryId === cat.id
			? 'bg-accent-soft text-accent'
			: 'text-dim hover:bg-panel-2 hover:text-ink'} {hidden ? 'hidden' : ''}"
	>
		<button
			class="flex items-center gap-1.5 self-stretch pl-2.5 text-sm font-medium"
			onclick={() => pick(cat)}
			title={cat.name}
			role="tab"
			aria-selected={app.categoryId === cat.id}
		>
			{cat.name}
			{#if ui.desktop || app.categoryId !== cat.id}
				<FreshnessDot ts={cat.updated_at_timestamp} />
			{/if}
		</button>
		{#if withMenu && ui.canMutate}
			<Menu
				label="Diary actions"
				items={[
					{ label: "Rename", onpick: () => onrenamecategory(cat) },
					{ label: "Delete", danger: true, onpick: () => ondeletecategory(cat) },
				]}
			>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
			</Menu>
		{/if}
	</div>
{/snippet}

<div class="relative">
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
				{@render chip(cat, overflow.breakIndex !== null && i >= overflow.breakIndex, ui.desktop || app.categoryId === cat.id)}
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
		{:else if orderedCategories.length === 0 && ui.canMutate}
			<!-- First-use affordance: with no diaries at all, creation must be visible in the strip. -->
			<button
				data-overflow-trailing
				class="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-faint transition-colors hover:bg-panel-2 hover:text-ink"
				onclick={requestNew}
				title="New diary"
			>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
				New
			</button>
		{/if}
		<div bind:this={moreEl} data-overflow-trailing class="shrink-0">
			<button
				title={extendedOpen ? "Hide extended diaries" : "Show all diaries"}
				aria-label="More diaries"
				aria-expanded={extendedOpen}
				class="flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-panel-2 hover:text-ink"
				onclick={toggleExtended}
			>
				<svg class="transition-transform {extendedOpen ? 'rotate-180' : ''}" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
			</button>
		</div>
	</div>

	{#if extendedOpen}
		<!-- invisible full-viewport click-catcher so any outside click closes the extension -->
		<button
			class="fixed inset-0 z-40 cursor-default"
			aria-label="Close diary list"
			tabindex="-1"
			onclick={closeExtended}
		></button>
		<div class="absolute inset-x-2 top-full z-50 mt-1 flex flex-col gap-2 rounded-lg border border-line bg-panel p-2 shadow-xl">
			<input
				bind:this={searchEl}
				bind:value={search}
				type="text"
				placeholder="Search diaries…"
				title="Search by name"
				aria-label="Search diaries"
				class="h-8 shrink-0 rounded-md border border-line bg-bg px-2.5 text-xs focus:border-accent focus:outline-none"
			/>
			<div class="flex max-h-64 flex-wrap gap-1.5 overflow-y-auto">
				{#each extendedCategories as cat (cat.id)}
					{@render chip(cat, false, true)}
				{/each}
				{#if extendedCategories.length === 0}
					<p class="px-1 py-1 text-xs text-faint">No matching diaries</p>
				{/if}
			</div>
			{#if ui.canMutate}
				<button
					class="flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-dashed border-line px-2.5 py-1.5 text-sm text-dim transition-colors hover:border-accent/50 hover:text-ink"
					onclick={requestNew}
					title="New diary"
				>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
					New diary
				</button>
			{/if}
		</div>
	{/if}
</div>
