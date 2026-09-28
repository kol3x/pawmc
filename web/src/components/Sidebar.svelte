<script lang="ts">
import { app } from "../lib/appState.svelte"
import { settings, setFreshnessFilter } from "../lib/settings.svelte"
import { FRESH_CUTOFFS, FRESH_FILTER_LABELS } from "../lib/freshness"
import type { CategorySummary, TopicSummary } from "../api-types"
import FreshnessDot from "./FreshnessDot.svelte"
import Menu from "./ui/Menu.svelte"
import IconButton from "./ui/IconButton.svelte"

interface Props {
	/** Close handler for the mobile drawer. */
	onclose?: () => void
	onrenamecategory: (cat: CategorySummary) => void
	ondeletecategory: (cat: CategorySummary) => void
	onrenametopic: (topic: TopicSummary) => void
	ondeletetopic: (topic: TopicSummary) => void
	onsettings: () => void
}

/**
 * Categories-first navigation: categories are top-level targets, topics nest under the active one.
 */
let {
	onclose,
	onrenamecategory,
	ondeletecategory,
	onrenametopic,
	ondeletetopic,
	onsettings,
}: Props = $props()

let search = $state("")
let expanded = $state<Set<number>>(new Set())

const query = $derived(search.trim().toLowerCase())
const cutoff = $derived(FRESH_CUTOFFS[settings.freshnessFilter])

const filtered = $derived.by(() => {
	const cats = app.categories ?? []
	return cats.flatMap((cat) => {
		const matched = cat.topics.filter((t) => {
			if (query && !t.name.toLowerCase().includes(query) && !cat.name.toLowerCase().includes(query))
				return false
			if (cutoff < Infinity) {
				if (!t.updated_at_timestamp || Date.now() / 1000 - t.updated_at_timestamp >= cutoff)
					return false
			}
			return true
		})
		if (!matched.length && (query || cutoff < Infinity)) return []
		return [{ ...cat, topics: matched }]
	})
})

function topicsVisible(cat: CategorySummary): boolean {
	return (
		query !== "" || cutoff < Infinity || expanded.has(cat.id) || app.categoryId === cat.id
	)
}

function toggleExpand(catId: number) {
	const next = new Set(expanded)
	if (next.has(catId)) next.delete(catId)
	else next.add(catId)
	expanded = next
}

</script>
<aside class="flex h-full w-72 shrink-0 flex-col border-r border-line bg-panel">
	<div class="flex items-center gap-1 px-4 pt-4 pb-2">
		<h1 class="flex-1 text-sm font-semibold tracking-tight">pawmc</h1>
		<IconButton title="Settings" onclick={onsettings}>
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
		</IconButton>
		{#if onclose}
			<IconButton title="Close menu" onclick={onclose}>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
			</IconButton>
		{/if}
	</div>

	<div class="flex flex-col gap-2 px-4 pb-3">
		<button
			class="flex h-9 items-center justify-center gap-2 rounded-lg bg-accent text-sm font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
			disabled={!app.selectedCategory}
			onclick={() => {
				app.startNewTopic()
				onclose?.()
			}}
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
			New topic
		</button>
		<div class="relative">
			<svg class="absolute left-2.5 top-2.5 text-faint" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
			<input
				placeholder="Search"
				bind:value={search}
				class="h-9 w-full rounded-lg border border-line bg-bg pl-8 pr-3 text-sm placeholder:text-faint focus:border-accent focus:outline-none"
			/>
		</div>
	</div>

	<div class="px-4 pb-3">
		<input
			type="range"
			min="0"
			max="3"
			step="1"
			value={settings.freshnessFilter}
			oninput={(e) => setFreshnessFilter(Number(e.currentTarget.value))}
			class="w-full accent-accent"
			aria-label="Filter topics by summary freshness"
		/>
		<div class="mt-1 flex justify-between text-[10px] uppercase tracking-wide">
			{#each FRESH_FILTER_LABELS as label, i (label)}
				<span class={i === settings.freshnessFilter ? "text-ink" : "text-faint"}>{label}</span>
			{/each}
		</div>
	</div>

	<nav class="flex-1 overflow-y-auto px-2 pb-4">
		{#if app.categories === null}
			<div class="px-2 py-4 text-xs text-faint">Loading…</div>
		{:else if !filtered.length}
			<div class="px-2 py-4 text-xs leading-relaxed text-faint">
				{#if query !== "" || cutoff < Infinity}
					No topics match the current filter.
				{:else}
					No topics yet. Start chatting below — a topic will be created automatically.
				{/if}
			</div>
		{:else}
			{#each filtered as cat (cat.id)}
				<div class="mb-0.5">
					<div
						class="flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors {app.categoryId === cat.id
							? 'bg-accent-soft'
							: 'hover:bg-panel-2'}"
					>
						<button
							class="flex h-6 w-5 items-center justify-center text-faint transition-transform hover:text-ink {topicsVisible(cat)
								? 'rotate-90'
								: ''}"
							onclick={() => toggleExpand(cat.id)}
							aria-label="Toggle topics"
						>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg>
						</button>
						<button
							class="min-w-0 flex-1 truncate text-left text-sm font-medium"
							onclick={() => {
								app.selectCategory(cat.id)
								onclose?.()
							}}
							title={cat.name}
						>
							{cat.name}
						</button>
						<FreshnessDot ts={cat.updated_at_timestamp} />
						<Menu
							label="Category actions"
							items={[
								{ label: "Rename", onpick: () => onrenamecategory(cat) },
								{ label: "Delete", danger: true, onpick: () => ondeletecategory(cat) },
							]}
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
						</Menu>
					</div>
					{#if topicsVisible(cat)}
						<div class="ml-6 border-l border-line pl-1.5">
							{#each cat.topics as topic (topic.id)}
								<div
									class="group flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors {app.topicId === topic.id
										? 'bg-accent-soft text-ink'
										: 'text-dim hover:bg-panel-2 hover:text-ink'}"
								>
									<button
										class="min-w-0 flex-1 truncate text-left text-xs"
										onclick={() => {
											app.selectTopic(cat.id, topic.id)
											onclose?.()
										}}
										title={topic.name}
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
										<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
									</Menu>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</nav>
</aside>
