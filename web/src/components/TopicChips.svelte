<script lang="ts">
import { app } from "../lib/appState.svelte"
import { ui } from "../lib/uiState.svelte"
import type { TopicSummary } from "../api"
import FreshnessDot from "./FreshnessDot.svelte"
import Menu from "./Menu.svelte"
import { createOverflowSplit } from "../lib/overflow.svelte"

interface Props {
	onrenametopic: (topic: TopicSummary) => void
	ondeletetopic: (topic: TopicSummary) => void
}

/**
 * Topic chip row for the active diary, most recently updated first. Chips past the
 * row's width collapse into an edge overflow dropdown; the active topic is pinned
 * to the front so it never hides behind the dropdown. The plus chip exits the
 * current topic so the next message gets a new auto-generated topic.
 */
let { onrenametopic, ondeletetopic }: Props = $props()

let rowEl = $state<HTMLElement | null>(null)
let moreEl = $state<HTMLElement | null>(null)

// Selected topic first so its rename/delete kebab stays reachable when the row overflows.
const orderedTopics = $derived.by(() => {
	const topics = app.selectedCategory?.topics ?? []
	const sorted = [...topics].sort((a, b) => b.updated_at_timestamp - a.updated_at_timestamp)
	const selected = sorted.find((t) => t.id === app.topicId)
	return selected ? [selected, ...sorted.filter((t) => t !== selected)] : sorted
})

const overflow = createOverflowSplit({
	deps: () => {
		void orderedTopics
	},
	row: () => rowEl,
	more: () => moreEl,
	gapPx: 6,
})

const moreItems = $derived.by(() => {
	if (overflow.breakIndex === null) return []
	return orderedTopics
		.slice(overflow.breakIndex)
		.map((topic) => ({
			label: topic.name,
			active: app.topicId === topic.id,
			onpick: () => app.selectTopic(app.categoryId!, topic.id),
		}))
})
</script>
<div
	bind:this={rowEl}
	class="relative flex items-center gap-1.5 overflow-hidden px-2 pb-1.5"
	aria-label="Topics"
>
	{#each orderedTopics as topic, i (topic.id)}
		<div
			data-overflow-item
			class="flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors {app.topicId === topic.id
				? 'border-accent/50 bg-accent-soft text-accent'
				: 'border-line text-dim hover:border-accent/40 hover:text-ink'} {overflow.breakIndex !== null && i >= overflow.breakIndex ? 'hidden' : ''}"
		>
			<button
				class="max-w-48 truncate"
				onclick={() => app.selectTopic(app.categoryId!, topic.id)}
				title={topic.micro_summary || topic.summary || topic.name}
			>
				{topic.name}
			</button>
			<FreshnessDot ts={topic.updated_at_timestamp} />
		{#if ui.canMutate}
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
	{/each}
	{#if ui.canMutate}
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
	<div
		bind:this={moreEl}
		data-overflow-trailing
		class="shrink-0 {overflow.breakIndex === null ? 'invisible' : ''}"
	>
		<Menu label="More topics" items={moreItems}>
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
		</Menu>
	</div>
</div>