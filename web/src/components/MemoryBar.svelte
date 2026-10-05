<script lang="ts">
import { app, pushToast } from "../lib/appState.svelte"
import { ui } from "../lib/uiState.svelte"
import { api, errorMessage } from "../api"
import { relativeTime } from "../lib/freshness"
import { renderMarkdown } from "../lib/markdown"
import { foldedSummary, type FoldedSummary } from "../lib/summary"
import type { SummaryType } from "../api"
import ConfirmModal from "./ConfirmModal.svelte"

interface MemoryCard {
	type: SummaryType
	label: string
	summary: string
	meta: string
	id?: number
}

interface Props {
	/** Present when the panel is shown inside the mobile drawer; renders a close button. */
	onclose?: () => void
}

/**
 * Left memory panel: the active topic's memory and the category overview as content-sized
 * cards. Large summaries show their opening paragraph with the rest folded behind a
 * "Show more" toggle; empty summaries render as one compact line. A mobile-only tab switcher
 * shows one card at a time; both cards stay stacked on md+ screens.
 */
let { onclose }: Props = $props()
let editing = $state<SummaryType | null>(null)
let editText = $state("")
let forgetType = $state<SummaryType | null>(null)
let refreshing = $state(false)
let mobileTab = $state<"topic" | "category">("topic")

const topic = $derived(app.selectedTopic)
const category = $derived(app.selectedCategory)
const topicFolded = $derived(topic?.summary ? foldedSummary(topic.summary) : null)
const categoryFolded = $derived(category?.summary ? foldedSummary(category.summary) : null)

function startEdit(card: MemoryCard) {
	editText = card.summary
	editing = card.type
}

async function saveEdit(card: MemoryCard) {
	if (!card.id) return
	try {
		await api("POST", "/update-summary", { type: card.type, id: card.id, summary: editText.trim() })
		editing = null
		await app.loadCategories()
		pushToast("Memory updated", "success")
	} catch (err) {
		pushToast(`Couldn't update memory — ${errorMessage(err)}`, "error")
	}
}

async function forget(card: MemoryCard) {
	forgetType = null
	if (!card.id) return
	try {
		await api("POST", "/update-summary", { type: card.type, id: card.id, summary: "" })
		await app.loadCategories()
		pushToast("Memory cleared", "success")
	} catch (err) {
		pushToast(`Couldn't clear memory — ${errorMessage(err)}`, "error")
	}
}

async function refreshAll() {
	refreshing = true
	try {
		await api("POST", "/update-summaries")
		await app.loadCategories()
		pushToast("Memory refreshed", "success")
	} catch (err) {
		pushToast(`Couldn't refresh memory — ${errorMessage(err)}`, "error")
	} finally {
		refreshing = false
	}
}

/**
 * Resolves the summary type the user confirmed to forget into its card, or null.
 */
function forgetCard(type: SummaryType | null): MemoryCard | null {
	if (type === "topic" && topic) return { type: "topic", label: "Topic memory", summary: topic.summary, meta: "", id: topic.id }
	if (type === "category" && category) return { type: "category", label: "Diary memory", summary: category.summary, meta: "", id: category.id }
	return null
}
</script>

{#snippet foldedBody(folded: FoldedSummary, fullText: string)}
	{#if folded.mode === "lede"}
		<div class="flex flex-col gap-1">
			<div class="md font-serif text-sm leading-relaxed text-dim md:text-base">{@html renderMarkdown(folded.lede)}</div>
			<details class="group flex flex-col">
				<summary class="order-last flex cursor-pointer select-none list-none items-center gap-1.5 rounded-md py-1 text-sm font-semibold text-ink transition-colors hover:text-accent [&::-webkit-details-marker]:hidden">
					<svg class="shrink-0 text-faint transition-transform group-open:rotate-90" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg>
					<span class="min-w-0 flex-1 group-open:hidden">Show more</span>
					<span class="hidden min-w-0 flex-1 group-open:inline">Show less</span>
				</summary>
				<div class="md py-1 font-serif text-sm leading-relaxed text-dim md:text-base">{@html renderMarkdown(folded.rest)}</div>
			</details>
		</div>
	{:else}
		<div class="md font-serif text-sm leading-relaxed text-dim md:text-base">{@html renderMarkdown(fullText)}</div>
	{/if}
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	<div class="flex items-center justify-between border-b border-line px-4 py-2.5">
		<span class="text-[10px] font-semibold uppercase tracking-wide text-faint">Memory</span>
		<div class="flex items-center gap-1">
			{#if ui.canMutate}
				<button
					class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-dim transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-40"
					disabled={refreshing}
					onclick={() => void refreshAll()}
					title="Rebuild memory from your conversations"
				>
					<svg class={refreshing ? "animate-spin" : ""} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>
					Refresh
				</button>
			{/if}
			{#if onclose}
				<button
					class="flex h-7 w-7 items-center justify-center rounded-md text-dim transition-colors hover:bg-panel-2 hover:text-ink"
					onclick={onclose}
					aria-label="Close"
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
				</button>
			{/if}
		</div>
	</div>
	{#if category}
		<div class="flex gap-1 border-b border-line px-3 py-2 md:hidden">
			<button
				class="flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors {mobileTab === 'topic' ? 'bg-accent-soft text-accent' : 'text-dim hover:bg-panel-2 hover:text-ink'}"
				onclick={() => (mobileTab = "topic")}
			>Topic memory</button>
			<button
				class="flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors {mobileTab === 'category' ? 'bg-accent-soft text-accent' : 'text-dim hover:bg-panel-2 hover:text-ink'}"
				onclick={() => (mobileTab = "category")}
			>Overview</button>
		</div>
	{/if}
	<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
		{#if !category}
			<p class="px-1 text-xs leading-relaxed text-faint">
				Pick a diary to see its memory build here as you talk.
			</p>
		{:else}
			{#if topic}
				{#if editing === "topic"}
					<div class="flex flex-col rounded-xl border border-line bg-panel p-3 {mobileTab === 'topic' ? 'flex' : 'hidden'} md:flex">
						<textarea
							bind:value={editText}
							rows="8"
							class="w-full resize-y rounded-lg border border-accent/60 bg-bg p-3 text-sm leading-relaxed focus:border-accent focus:outline-none md:text-base"
						></textarea>
						<div class="mt-2 flex justify-end gap-2">
							<button class="rounded-lg border border-line px-3 py-1.5 text-xs text-dim hover:text-ink" onclick={() => (editing = null)}>Cancel</button>
							<button class="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/85" onclick={() => void saveEdit({ type: "topic", label: "Topic memory", summary: topic.summary, meta: "", id: topic.id })}>Save</button>
						</div>
					</div>
				{:else if topicFolded}
					<div class="flex flex-col rounded-xl border border-line bg-panel {mobileTab === 'topic' ? 'flex' : 'hidden'} md:flex">
						<div class="flex items-center gap-2 border-b border-line px-3 py-2">
							<h3 class="text-xs font-semibold uppercase tracking-wide text-dim">Topic memory</h3>
							<span class="text-[10px] text-faint">{relativeTime(topic.updated_at_timestamp)}</span>
						<div class="flex-1"></div>
						{#if ui.canMutate}
							<button class="text-faint transition-colors hover:text-ink" title="Revise" onclick={() => startEdit({ type: "topic", label: "Topic memory", summary: topic.summary, meta: "", id: topic.id })}>
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
							</button>
							<button class="text-faint transition-colors hover:text-danger" title="Forget" onclick={() => (forgetType = "topic")}>
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
							</button>
						{/if}
					</div>
					<div class="px-3 py-3">
						{@render foldedBody(topicFolded, topic.summary)}
					</div>
					</div>
				{:else}
					<div class="flex items-center gap-2 px-1 {mobileTab === 'topic' ? '' : 'hidden'} md:flex">
						<p class="text-xs text-faint">No memory yet — it builds as you talk.</p>
						{#if ui.canMutate}
							<button class="shrink-0 text-faint transition-colors hover:text-ink" title="Write memory" onclick={() => startEdit({ type: "topic", label: "Topic memory", summary: "", meta: "", id: topic.id })}>
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
							</button>
						{/if}
					</div>
				{/if}
			{:else}
				<p class="px-1 text-xs text-faint {mobileTab === 'topic' ? '' : 'hidden'} md:block">No topic selected — memory appears once a topic is active.</p>
			{/if}
			{#if editing === "category"}
				<div class="flex flex-col rounded-xl border border-line bg-panel p-3 {mobileTab === 'category' ? 'flex' : 'hidden'} md:flex">
					<textarea
						bind:value={editText}
						rows="8"
						class="w-full resize-y rounded-lg border border-accent/60 bg-bg p-3 text-sm leading-relaxed focus:border-accent focus:outline-none md:text-base"
					></textarea>
					<div class="mt-2 flex justify-end gap-2">
						<button class="rounded-lg border border-line px-3 py-1.5 text-xs text-dim hover:text-ink" onclick={() => (editing = null)}>Cancel</button>
						<button class="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/85" onclick={() => void saveEdit({ type: "category", label: "Diary memory", summary: category.summary, meta: "", id: category.id })}>Save</button>
					</div>
				</div>
			{:else if categoryFolded}
				<div class="flex flex-col rounded-xl border border-line bg-panel {mobileTab === 'category' ? 'flex' : 'hidden'} md:flex">
					<div class="flex items-center gap-2 border-b border-line px-3 py-2">
						<h3 class="text-xs font-semibold uppercase tracking-wide text-dim">Diary memory</h3>
						<span class="text-[10px] text-faint">{relativeTime(category.updated_at_timestamp)}</span>
					<div class="flex-1"></div>
					{#if ui.canMutate}
						<button class="text-faint transition-colors hover:text-ink" title="Revise" onclick={() => startEdit({ type: "category", label: "Diary memory", summary: category.summary, meta: "", id: category.id })}>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
						</button>
						<button class="text-faint transition-colors hover:text-danger" title="Forget" onclick={() => (forgetType = "category")}>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
						</button>
					{/if}
				</div>
					<div class="px-3 py-3">
						{@render foldedBody(categoryFolded, category.summary)}
					</div>
				</div>
			{:else}
				<div class="flex items-center gap-2 px-1 {mobileTab === 'category' ? '' : 'hidden'} md:flex">
					<p class="text-xs text-faint">No diary memory yet — it builds from topic memories.</p>
					{#if ui.canMutate}
						<button class="shrink-0 text-faint transition-colors hover:text-ink" title="Write memory" onclick={() => startEdit({ type: "category", label: "Diary memory", summary: "", meta: "", id: category.id })}>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
						</button>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
</div>

<ConfirmModal
	open={forgetType !== null}
	title="Forget memory"
	body={`Clear the ${forgetType ?? ""} memory? Your conversations stay — memory rebuilds from them next time it updates.`}
	onconfirm={() => {
		const card = forgetCard(forgetType)
		if (card) void forget(card)
	}}
	onclose={() => (forgetType = null)}
/>
