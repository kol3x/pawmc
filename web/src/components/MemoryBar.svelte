<script lang="ts">
import { app } from "../lib/appState.svelte"
import { api } from "../api"
import { relativeTime } from "../lib/freshness"
import { renderMarkdown } from "../lib/markdown"
import { pushToast } from "../lib/toasts.svelte"
import type { SummaryType } from "../api-types"
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
 * Left memory panel: the active topic's memory and the category overview, always visible,
 * with revise/forget/refresh actions.
 */
let { onclose }: Props = $props()
let editing = $state<SummaryType | null>(null)
let editText = $state("")
let forgetType = $state<SummaryType | null>(null)
let refreshing = $state(false)

const topic = $derived(app.selectedTopic)
const category = $derived(app.selectedCategory)

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
		pushToast("Summaries refreshed", "success")
	} catch (err) {
		pushToast(`Couldn't refresh summaries — ${errorMessage(err)}`, "error")
	} finally {
		refreshing = false
	}
}

/**
 * Resolves the summary type the user confirmed to forget into its card, or null.
 */
function forgetCard(type: SummaryType | null): MemoryCard | null {
	if (type === "topic" && topic) return { type: "topic", label: "Topic memory", summary: topic.summary, meta: "", id: topic.id }
	if (type === "category" && category) return { type: "category", label: "Category overview", summary: category.summary, meta: "", id: category.id }
	return null
}

/**
 * Formats a thrown value for toasts: the message for Error instances, the stringified value otherwise.
 */
function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}
</script>
<div class="flex min-h-0 flex-1 flex-col">
	<div class="flex items-center justify-between border-b border-line px-4 py-2.5">
		<span class="text-[10px] font-semibold uppercase tracking-wide text-faint">Memory</span>
		<div class="flex items-center gap-1">
			<button
				class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-dim transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-40"
				disabled={refreshing}
				onclick={() => void refreshAll()}
				title="Refresh all summaries"
			>
				<svg class={refreshing ? "animate-spin" : ""} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>
				Refresh
			</button>
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
	<div class="flex min-h-0 flex-1 flex-col gap-3 p-3">
		{#if !category}
			<p class="px-1 text-xs leading-relaxed text-faint">
				Pick a category to see its memory build here as conversations get folded.
			</p>
		{:else}
			{#if topic}
				<div class="flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-panel">
					<div class="flex items-center gap-2 border-b border-line px-3 py-2">
						<h3 class="text-xs font-semibold uppercase tracking-wide text-dim">Topic memory</h3>
						<span class="text-[10px] text-faint">{relativeTime(topic.updated_at_timestamp)}</span>
						<div class="flex-1"></div>
						<button class="text-faint transition-colors hover:text-ink" title="Revise" onclick={() => startEdit({ type: "topic", label: "Topic memory", summary: topic.summary, meta: "", id: topic.id })}>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
						</button>
						<button class="text-faint transition-colors hover:text-danger" title="Forget" onclick={() => (forgetType = "topic")}>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
						</button>
					</div>
					<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
						{#if editing === "topic"}
							<textarea
								bind:value={editText}
								rows="8"
								class="w-full resize-y rounded-lg border border-accent/60 bg-bg p-3 text-sm leading-relaxed focus:border-accent focus:outline-none"
							></textarea>
							<div class="mt-2 flex justify-end gap-2">
								<button class="rounded-lg border border-line px-3 py-1.5 text-xs text-dim hover:text-ink" onclick={() => (editing = null)}>Cancel</button>
								<button class="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/85" onclick={() => void saveEdit({ type: "topic", label: "Topic memory", summary: topic.summary, meta: "", id: topic.id })}>Save</button>
							</div>
						{:else if topic.summary}
							<div class="md text-sm leading-relaxed text-dim">{@html renderMarkdown(topic.summary)}</div>
						{:else}
							<p class="text-xs text-faint">No topic memory yet — it builds as conversations get folded.</p>
						{/if}
					</div>
				</div>
			{:else}
				<p class="px-1 text-xs text-faint">No topic selected — memory appears once a topic is active.</p>
			{/if}
			<div class="flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-panel">
				<div class="flex items-center gap-2 border-b border-line px-3 py-2">
					<h3 class="text-xs font-semibold uppercase tracking-wide text-dim">Category overview</h3>
					<span class="text-[10px] text-faint">{relativeTime(category.updated_at_timestamp)}</span>
					<div class="flex-1"></div>
					<button class="text-faint transition-colors hover:text-ink" title="Revise" onclick={() => startEdit({ type: "category", label: "Category overview", summary: category.summary, meta: "", id: category.id })}>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
					</button>
					<button class="text-faint transition-colors hover:text-danger" title="Forget" onclick={() => (forgetType = "category")}>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
					</button>
				</div>
				<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
					{#if editing === "category"}
						<textarea
							bind:value={editText}
							rows="8"
							class="w-full resize-y rounded-lg border border-accent/60 bg-bg p-3 text-sm leading-relaxed focus:border-accent focus:outline-none"
						></textarea>
						<div class="mt-2 flex justify-end gap-2">
							<button class="rounded-lg border border-line px-3 py-1.5 text-xs text-dim hover:text-ink" onclick={() => (editing = null)}>Cancel</button>
							<button class="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/85" onclick={() => void saveEdit({ type: "category", label: "Category overview", summary: category.summary, meta: "", id: category.id })}>Save</button>
						</div>
					{:else if category.summary}
						<div class="md text-sm leading-relaxed text-dim">{@html renderMarkdown(category.summary)}</div>
					{:else}
						<p class="text-xs text-faint">No category overview yet — it builds from topic memories.</p>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>

<ConfirmModal
	open={forgetType !== null}
	title="Forget memory"
	body={`Clear the ${forgetType ?? ""} memory? Existing conversations stay; the memory rebuilds from them on the next summary update.`}
	onconfirm={() => {
		const card = forgetCard(forgetType)
		if (card) void forget(card)
	}}
	onclose={() => (forgetType = null)}
/>