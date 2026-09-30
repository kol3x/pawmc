<script lang="ts">
import { app } from "../lib/appState.svelte"
import type { TopicSummary } from "../api"
import FreshnessDot from "./FreshnessDot.svelte"
import Menu from "./Menu.svelte"

interface Props {
	onrenametopic: (topic: TopicSummary) => void
	ondeletetopic: (topic: TopicSummary) => void
}

/**
 * Topic chip row for the active category, most recently updated first, with a plus chip entering new-topic mode.
 */
let { onrenametopic, ondeletetopic }: Props = $props()

const byRecency = $derived.by(() => {
	const topics = app.selectedCategory?.topics ?? []
	return [...topics].sort((a, b) => b.updated_at_timestamp - a.updated_at_timestamp)
})
</script>
<div class="flex items-center gap-1.5 overflow-x-auto px-2 pb-1.5" aria-label="Topics">
	{#each byRecency as topic (topic.id)}
		<div
			class="flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors {app.topicId === topic.id
				? 'border-accent/50 bg-accent-soft text-accent'
				: 'border-line text-dim hover:border-accent/40 hover:text-ink'}"
		>
			<button
				class="max-w-48 truncate"
				onclick={() => app.selectTopic(app.categoryId!, topic.id)}
				title={topic.micro_summary || topic.summary || topic.name}
			>
				{topic.name}
			</button>
			<FreshnessDot ts={topic.updated_at_timestamp} />
			<Menu
				label="Topic actions"
				items={[
					{ label: "Rename", onpick: () => onrenametopic(topic) },
					{ label: "Delete", danger: true, onpick: () => ondeletetopic(topic) },
				]}
			>
				<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
			</Menu>
		</div>
	{/each}
	<button
		class="flex shrink-0 items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs text-faint transition-colors hover:border-accent/40 hover:text-ink"
		onclick={() => app.deselectTopic()}
		title="Start a new topic — the next message gets one automatically"
	>
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
		New topic
	</button>
</div>