<script lang="ts">
import { tick } from "svelte"
import { app } from "../lib/appState.svelte"
import { ui } from "../lib/uiState.svelte"
import type { TopicSummary } from "../api"
import FreshnessDot from "./FreshnessDot.svelte"
import Menu from "./Menu.svelte"
import { createOverflowSplit } from "../lib/overflow.svelte"
import { freshnessOrderWithSelected } from "../lib/freshness"

interface Props {
	onrenametopic: (topic: TopicSummary) => void
	ondeletetopic: (topic: TopicSummary) => void
}

/**
 * Topic chip row for the active diary, most recently updated first. Chips past the
 * row's width collapse behind an edge chevron that expands a multiline extension
 * panel below the row: the same full chips (rename/delete kebab on every entry, freshness dot
 * on non-selected ones) plus a search input that searches all topics of the diary by title
 * or summary, including ones already visible in the strip. The chevron (and with it the
 * extension panel) only renders once the diary has at least one topic. On mobile the strip chips keep
 * the kebab only on the selected topic. The
 * panel closes — and the search resets — when a topic is picked or a click lands
 * outside it. The plus chip exits the current topic so the next message gets a
 * new auto-generated topic.
 */
let { onrenametopic, ondeletetopic }: Props = $props()

let rowEl = $state<HTMLElement | null>(null)
let moreEl = $state<HTMLElement | null>(null)
let searchEl = $state<HTMLInputElement | null>(null)
let extendedOpen = $state(false)
let search = $state("")

// Selected topic first so its rename/delete kebab stays reachable when the row overflows.
const orderedTopics = $derived.by(() =>
	freshnessOrderWithSelected(app.selectedCategory?.topics ?? [], app.topicId),
)

const overflow = createOverflowSplit({
	deps: () => {
		void orderedTopics
	},
	row: () => rowEl,
	more: () => moreEl,
	gapPx: 6,
})

// Extension contents: the topics the inline row could not fit — or, when nothing overflows,
// the full list. A search query widens the panel to every topic of the diary matching by title
// or summary, including ones already visible in the strip.
const extendedTopics = $derived.by(() => {
	const q = search.trim().toLowerCase()
	if (q)
		return orderedTopics.filter(
			(topic) =>
				topic.name.toLowerCase().includes(q) ||
				topic.summary.toLowerCase().includes(q) ||
				(topic.micro_summary ?? "").toLowerCase().includes(q),
		)
	return orderedTopics.slice(overflow.breakIndex ?? 0)
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

function pick(topic: TopicSummary) {
	app.selectTopic(app.categoryId!, topic.id)
	closeExtended()
}
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && extendedOpen && closeExtended()} />

{#snippet chip(topic: TopicSummary, hidden = false, withMenu = false)}
	<div
		data-overflow-item
		class="flex shrink-0 items-center gap-1 rounded-full border py-1 text-xs transition-colors {withMenu && ui.canMutate ? 'pr-1' : 'pr-2.5'} {app.topicId === topic.id
			? 'border-accent/50 bg-accent-soft text-accent'
			: 'border-line text-dim hover:border-accent/40 hover:text-ink'} {hidden ? 'hidden' : ''}"
	>
		<button
			class="flex items-center gap-1.5 self-stretch pl-2.5"
			onclick={() => pick(topic)}
			title={topic.micro_summary || topic.summary || topic.name}
		>
			<span class="max-w-48 truncate">{topic.name}</span>
			{#if ui.desktop || app.topicId !== topic.id}
				<FreshnessDot ts={topic.updated_at_timestamp} />
			{/if}
		</button>
	{#if withMenu && ui.canMutate}
		<Menu
			label="Topic actions"
			items={[
				{ label: "Rename", onpick: () => onrenametopic(topic) },
				{ label: "Delete", danger: true, onpick: () => ondeletetopic(topic) },
			]}
		>
			<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
		</Menu>
	{/if}
	</div>
{/snippet}

<div class="relative">
	<div
		bind:this={rowEl}
		class="relative flex items-center gap-1.5 overflow-hidden px-2 pb-1.5"
		aria-label="Topics"
	>
		{#each orderedTopics as topic, i (topic.id)}
			{@render chip(topic, overflow.breakIndex !== null && i >= overflow.breakIndex, ui.desktop || app.topicId === topic.id)}
		{/each}
		{#if ui.canMutate && app.topicId !== null}
			<button
				data-overflow-trailing
				class="flex shrink-0 items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs text-faint transition-colors hover:border-accent/40 hover:text-ink"
				onclick={() => app.deselectTopic()}
				title="Start a new topic — the next message gets one automatically"
			>
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
				New topic
			</button>
		{/if}
		{#if (app.selectedCategory?.topics?.length ?? 0) > 0}
			<div bind:this={moreEl} data-overflow-trailing class="shrink-0">
				<button
					title={extendedOpen ? "Hide extended topics" : "Search and show all topics"}
					aria-label="More topics"
					aria-expanded={extendedOpen}
					class="flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-panel-2 hover:text-ink"
					onclick={toggleExtended}
				>
					<svg class="transition-transform {extendedOpen ? 'rotate-180' : ''}" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
				</button>
			</div>
		{/if}
	</div>

	{#if extendedOpen}
		<!-- invisible full-viewport click-catcher so any outside click closes the extension -->
		<button
			class="fixed inset-0 z-40 cursor-default"
			aria-label="Close topic list"
			tabindex="-1"
			onclick={closeExtended}
		></button>
		<div class="absolute inset-x-2 top-full z-50 mt-1 flex flex-col gap-2 rounded-lg border border-line bg-panel p-2 shadow-xl">
			<input
				bind:this={searchEl}
				bind:value={search}
				type="text"
				placeholder="Search topics…"
				title="Search by title or summary"
				aria-label="Search topics"
				class="h-8 shrink-0 rounded-md border border-line bg-bg px-2.5 text-xs focus:border-accent focus:outline-none"
			/>
			<div class="flex max-h-64 flex-wrap gap-1.5 overflow-y-auto">
				{#each extendedTopics as topic (topic.id)}
					{@render chip(topic, false, true)}
				{/each}
				{#if extendedTopics.length === 0}
					<p class="px-1 py-1 text-xs text-faint">No matching topics</p>
				{/if}
			</div>
		</div>
	{/if}
</div>
