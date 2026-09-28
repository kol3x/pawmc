<script lang="ts">
import { app } from "../lib/appState.svelte"
import { api } from "../api"
import { relativeTime } from "../lib/freshness"
import { renderMarkdown } from "../lib/markdown"
import { pushToast } from "../lib/toasts.svelte"
import type { SummaryType } from "../api-types"
import Modal from "./ui/Modal.svelte"

/**
 * Context view: topic and category memory cards with revise/forget/fullscreen actions.
 */
let editing = $state<SummaryType | null>(null)
let editText = $state("")
let fullscreen = $state<SummaryType | null>(null)
let forgetType = $state<SummaryType | null>(null)
let refreshing = $state(false)

const topicSummary = $derived(app.selectedTopic?.summary ?? "")
const categorySummary = $derived(app.selectedCategory?.summary ?? "")

function startEdit(type: SummaryType) {
	editText = type === "topic" ? topicSummary : categorySummary
	editing = type
}

async function saveEdit(type: SummaryType) {
	const id = type === "topic" ? app.selectedTopic?.id : app.selectedCategory?.id
	if (!id) return
	try {
		await api("POST", "/update-summary", { type, id, summary: editText.trim() })
		editing = null
		await app.loadCategories()
		pushToast("Memory updated", "success")
	} catch (err) {
		pushToast(`Couldn't update memory — ${err instanceof Error ? err.message : String(err)}`, "error")
	}
}

async function forget(type: SummaryType) {
	const id = type === "topic" ? app.selectedTopic?.id : app.selectedCategory?.id
	forgetType = null
	if (!id) return
	try {
		await api("POST", "/update-summary", { type, id, summary: "" })
		await app.loadCategories()
		pushToast("Memory cleared", "success")
	} catch (err) {
		pushToast(`Couldn't clear memory — ${err instanceof Error ? err.message : String(err)}`, "error")
	}
}

async function refreshAll() {
	refreshing = true
	try {
		await api("POST", "/update-summaries")
		await app.loadCategories()
		pushToast("Summaries refreshed", "success")
	} catch (err) {
		pushToast(`Couldn't refresh summaries — ${err instanceof Error ? err.message : String(err)}`, "error")
	} finally {
		refreshing = false
	}
}

const htmlTopic = $derived(renderMarkdown(topicSummary))
const htmlCategory = $derived(renderMarkdown(categorySummary))
const metaTopic = $derived(app.selectedTopic ? relativeTime(app.selectedTopic.updated_at_timestamp) : "")
const metaCategory = $derived(app.selectedCategory ? relativeTime(app.selectedCategory.updated_at_timestamp) : "")

</script>
<div class="flex-1 overflow-y-auto px-4 py-4">
	<div class="mx-auto flex max-w-3xl flex-col gap-3">
		<div class="flex items-center justify-between">
			<h2 class="text-xs font-semibold uppercase tracking-wide text-faint">Context</h2>
			<button
				class="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-dim transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-40"
				disabled={refreshing}
				onclick={() => void refreshAll()}
			>
				<svg class={refreshing ? "animate-spin" : ""} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>
				Refresh all summaries
			</button>
		</div>

		{#each [{ type: "topic" as SummaryType, label: "Topic memory", summary: topicSummary, meta: metaTopic, html: htmlTopic }, { type: "category" as SummaryType, label: "Category overview", summary: categorySummary, meta: metaCategory, html: htmlCategory }] as card (card.type)}
			<div class="rounded-xl border border-line bg-panel">
				<div class="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
					<h3 class="text-sm font-medium">{card.label}</h3>
					<span class="text-[10px] text-faint">updated {card.meta}</span>
					<div class="flex-1"></div>
					<button class="text-faint hover:text-ink" title="Fullscreen" onclick={() => (fullscreen = card.type)}>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
					</button>
					<button class="text-faint hover:text-ink" title="Revise" onclick={() => startEdit(card.type)}>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
					</button>
					<button class="text-faint hover:text-danger" title="Forget" onclick={() => (forgetType = card.type)}>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
					</button>
				</div>
				<div class="px-3.5 py-3">
					{#if editing === card.type}
						<textarea
							bind:value={editText}
							rows="8"
							class="w-full resize-y rounded-lg border border-accent/60 bg-bg p-3 text-sm leading-relaxed focus:border-accent focus:outline-none"
						></textarea>
						<div class="mt-2 flex justify-end gap-2">
							<button class="rounded-lg border border-line px-3 py-1.5 text-xs text-dim hover:text-ink" onclick={() => (editing = null)}>Cancel</button>
							<button class="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/85" onclick={() => void saveEdit(card.type)}>Save</button>
						</div>
					{:else if card.summary}
						<div class="md max-h-64 overflow-y-auto text-sm leading-relaxed text-dim">{@html card.html}</div>
					{:else}
						<p class="text-xs text-faint">
							{card.type === "topic" ? "No topic memory yet — it builds as conversations get folded." : "No category overview yet — it builds from topic memories."}
						</p>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</div>

<Modal title={fullscreen === "topic" ? "Topic memory" : "Category overview"} open={fullscreen !== null} onclose={() => (fullscreen = null)} maxWidth="max-w-2xl">
	<div class="md max-h-[60vh] overflow-y-auto text-sm leading-relaxed">
		{@html fullscreen === "topic" ? htmlTopic : htmlCategory}
	</div>
</Modal>

<Modal title="Forget memory" open={forgetType !== null} onclose={() => (forgetType = null)}>
	<p class="text-sm text-dim">
		Clear the {forgetType === "topic" ? "topic" : "category"} memory? Existing conversations stay; the memory rebuilds from them on the next summary update.
	</p>
	<div class="mt-4 flex justify-end gap-2">
		<button class="h-9 rounded-lg border border-line px-3.5 text-sm text-dim hover:text-ink" onclick={() => (forgetType = null)}>Cancel</button>
		<button class="h-9 rounded-lg bg-danger px-3.5 text-sm font-medium text-white hover:bg-danger/85" onclick={() => forgetType && void forget(forgetType)}>Forget</button>
	</div>
</Modal>
