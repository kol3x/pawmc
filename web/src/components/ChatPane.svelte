<script lang="ts">
import { app, pushToast, type ConversationGroup, type StreamMessage } from "../lib/appState.svelte"
import { relativeTime } from "../lib/freshness"
import { api, ApiError, errorMessage } from "../api"
import MessageBubble from "./MessageBubble.svelte"
import Composer from "./Composer.svelte"
import MemoryBar from "./MemoryBar.svelte"
import TopicPicker from "./TopicPicker.svelte"
import Menu from "./Menu.svelte"
import ConfirmModal from "./ConfirmModal.svelte"

/**
 * The conversation view: memory panel on the left (md+ screens), autotopic picker,
 * the continuous message stream (folded conversations spoiler-collapsed behind their
 * summary), and the composer on the right.
 */
let composerRef = $state<Composer | null>(null)
let deleteGroup = $state<ConversationGroup | null>(null)
let expandedSpoilers = $state<Set<number>>(new Set())

export function focusComposer() {
	composerRef?.focus()
}

async function saveEdit(msg: StreamMessage, content: string) {
	try {
		await api("POST", "/update-message", { id: msg.conversationId, index: msg.index, content })
		await app.loadStream()
		pushToast("Message updated", "success")
	} catch (err) {
		if (err instanceof ApiError && err.status === 404)
			pushToast("Message editing needs a backend update (v2)", "error")
		else pushToast(`Couldn't edit — ${errorMessage(err)}`, "error")
	}
}

async function deleteMessage(msg: StreamMessage) {
	try {
		await api("DELETE", `/message?id=${msg.conversationId}&index=${msg.index}`)
		await app.loadStream()
	} catch (err) {
		if (err instanceof ApiError && err.status === 404)
			pushToast("Message deletion needs a backend update (v2)", "error")
		else pushToast(`Couldn't delete — ${errorMessage(err)}`, "error")
	}
}

async function deleteConversation() {
	const group = deleteGroup
	deleteGroup = null
	if (!group) return
	try {
		await api("DELETE", `/conversation?id=${group.id}`)
		await app.loadStream()
		await app.loadCategories()
	} catch (err) {
		pushToast(`Couldn't delete conversation — ${errorMessage(err)}`, "error")
	}
}

function toggleSpoiler(group: ConversationGroup) {
	const next = new Set(expandedSpoilers)
	if (next.has(group.id)) next.delete(group.id)
	else next.add(group.id)
	expandedSpoilers = next
}

let scrollerEl = $state<HTMLElement | null>(null)
let nearBottom = $state(true)

function onScroll() {
	const el = scrollerEl
	if (!el) return
	nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

$effect(() => {
	void app.stream.length
	if (nearBottom && scrollerEl) scrollerEl.scrollTop = scrollerEl.scrollHeight
})

function fmtDate(ts: number): string {
	return new Date(ts * 1000).toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	})
}

const spoilerSummary = $derived(app.selectedTopic?.micro_summary || app.selectedTopic?.summary || "")

/**
 * Hands a cancelled autotopic pick back to the composer.
 */
function restoreDraft(draft: string) {
	composerRef?.setDraft(draft)
	composerRef?.focus()
}
</script>
<div class="flex min-h-0 flex-1">
	<aside class="hidden w-[26rem] shrink-0 flex-col border-r border-line bg-panel/40 md:flex xl:w-[30rem]">
		<MemoryBar />
	</aside>
	<div class="flex min-w-0 flex-1 flex-col">
		<TopicPicker oncancel={restoreDraft} />
		<div bind:this={scrollerEl} onscroll={onScroll} class="flex-1 overflow-y-auto px-4 py-4">
		{#if !app.selectedCategory && !app.pendingCategoryName}
			<div class="flex h-full items-center justify-center">
				<p class="max-w-xs text-center text-xs leading-relaxed text-faint">
					Pick a category above — or start a new one with the + chip. New categories become real with your first message.
				</p>
			</div>
		{:else if !app.stream.length}
			{#if app.loadingStream}
				<div class="flex h-full items-center justify-center">
					<svg class="animate-spin text-faint" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>
				</div>
			{:else}
				<div class="flex h-full items-center justify-center">
					<p class="max-w-xs text-center text-xs leading-relaxed text-faint">
						{#if app.pendingCategoryName}
							"{app.pendingCategoryName}" is ready — your first message here creates it and starts the conversation.
						{:else if app.selectedTopic}
							{app.selectedTopic.summary
								? "Memory holds the context of this topic. Messages you send continue below."
								: "Messages you send appear here and keep building this topic's memory."}
						{:else}
							Send your first message — a topic is generated for it automatically, or pick an existing one above.
						{/if}
					</p>
				</div>
			{/if}
		{:else}
			<div class="mx-auto flex max-w-3xl flex-col gap-1">
				{#each app.stream as group (group.id < 0 ? `temp-${group.createdAt}` : group.id)}
					{#if group.summarized}
						<div class="rounded-xl border border-line bg-panel/60">
							<div class="flex items-center gap-2 px-3 py-2.5">
								<button
									class="flex min-w-0 flex-1 items-center gap-2 text-left"
									onclick={() => toggleSpoiler(group)}
									aria-expanded={expandedSpoilers.has(group.id)}
								>
									<span class="shrink-0 text-[10px] text-faint">{fmtDate(group.createdAt)} · {relativeTime(group.createdAt)}</span>
									<span class="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-faint">folded into memory</span>
									{#if spoilerSummary}
										<span class="min-w-0 flex-1 truncate text-xs text-dim">{spoilerSummary}</span>
									{/if}
									<svg
										class="shrink-0 text-faint transition-transform {expandedSpoilers.has(group.id) ? 'rotate-90' : ''}"
										width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
									><polyline points="9 6 15 12 9 18"/></svg>
								</button>
								{#if group.id > 0}
									<Menu label="Conversation actions" items={[
										{ label: "Delete conversation", danger: true, onpick: () => (deleteGroup = group) },
									]}>
										<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
									</Menu>
								{/if}
							</div>
							{#if expandedSpoilers.has(group.id)}
								<div class="flex flex-col gap-2.5 border-t border-line px-3 py-3">
									{#each group.messages as msg (msg.pending ? `p-${msg.createdAt}` : `${group.id}-${msg.index}`)}
										<MessageBubble {msg} canEdit={false} canMutate={false} onedit={saveEdit} ondelete={deleteMessage} />
									{/each}
								</div>
							{/if}
						</div>
					{:else}
						<div class="border-l-2 border-accent/50 pl-3">
							<div class="mb-1.5 flex items-center gap-2 text-[10px] text-faint">
								<span>{fmtDate(group.createdAt)} · {relativeTime(group.createdAt)}</span>
								<span class="rounded-full border border-accent/40 bg-accent-soft px-1.5 py-0.5 uppercase tracking-wide text-accent">current</span>
								{#if group.id > 0}
									<Menu label="Conversation actions" items={[
										{ label: "Delete conversation", danger: true, onpick: () => (deleteGroup = group) },
									]}>
										<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
									</Menu>
								{/if}
							</div>
							<div class="flex flex-col gap-2.5 pb-3">
								{#each group.messages as msg (msg.pending ? `p-${msg.createdAt}` : `${group.id}-${msg.index}`)}
									<MessageBubble
										{msg}
										canEdit={msg.role === "user" && !group.summarized && !msg.pending && group.id > 0}
										canMutate={!group.summarized && !msg.pending && group.id > 0}
										onedit={saveEdit}
										ondelete={deleteMessage}
									/>
								{/each}
							</div>
						</div>
					{/if}
				{/each}
				{#if app.sending && !app.stream.some((g) => g.messages.some((m) => m.pending))}
					<div class="text-xs text-faint">thinking…</div>
				{/if}
			</div>
		{/if}
	</div>
	<Composer bind:this={composerRef} onsend={app.sendMessage} />
</div>
</div>

<ConfirmModal
	open={deleteGroup !== null}
	title="Delete conversation"
	body="Delete this whole conversation? If it was already folded into memory, the memory keeps its content."
	onconfirm={deleteConversation}
	onclose={() => (deleteGroup = null)}
/>