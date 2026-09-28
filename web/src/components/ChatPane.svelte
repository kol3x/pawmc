<script lang="ts">
import { app, type ConversationGroup, type StreamMessage } from "../lib/appState.svelte"
import { relativeTime } from "../lib/freshness"
import { api, ApiError } from "../api"
import { pushToast } from "../lib/toasts.svelte"
import MessageBubble from "./MessageBubble.svelte"
import Composer from "./Composer.svelte"
import Menu from "./ui/Menu.svelte"
import ConfirmModal from "./ConfirmModal.svelte"

/**
 * The continuous conversation view: all conversations of the topic merged into one
 * ascending stream, separated by fold dividers, with the composer at the bottom.
 */
let composerRef = $state<Composer | null>(null)
let deleteGroup = $state<ConversationGroup | null>(null)

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
		else pushToast(`Couldn't edit — ${err instanceof Error ? err.message : String(err)}`, "error")
	}
}

async function deleteMessage(msg: StreamMessage) {
	try {
		await api("DELETE", `/message?id=${msg.conversationId}&index=${msg.index}`)
		await app.loadStream()
	} catch (err) {
		if (err instanceof ApiError && err.status === 404)
			pushToast("Message deletion needs a backend update (v2)", "error")
		else pushToast(`Couldn't delete — ${err instanceof Error ? err.message : String(err)}`, "error")
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
		pushToast(`Couldn't delete conversation — ${err instanceof Error ? err.message : String(err)}`, "error")
	}
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

</script>
<div class="flex min-h-0 flex-1 flex-col">
	<div bind:this={scrollerEl} onscroll={onScroll} class="flex-1 overflow-y-auto px-4 py-4">
		{#if !app.selectedTopic && !app.newTopicMode && app.selectedCategory}
			<div class="flex h-full items-center justify-center">
				<p class="max-w-xs text-center text-xs leading-relaxed text-faint">
					No topics in this category yet. Type a topic name (or leave it blank to auto-generate) and send your first message.
				</p>
			</div>
		{:else if app.newTopicMode}
			<div class="flex h-full items-center justify-center">
				<p class="max-w-xs text-center text-xs leading-relaxed text-faint">
					Your first message creates the topic — name it above, or leave blank to let the assistant name it.
				</p>
			</div>
		{:else if !app.stream.length && !app.loadingStream && app.selectedTopic}
			<div class="flex h-full items-center justify-center">
				<p class="max-w-xs text-center text-xs leading-relaxed text-faint">
					{app.selectedTopic.summary
						? "Memory holds the context of this topic. Messages you send continue below."
						: "Messages you send appear here and keep building this topic's memory."}
				</p>
			</div>
		{:else}
			<div class="mx-auto flex max-w-3xl flex-col gap-1">
				{#each app.stream as group (group.id < 0 ? `temp-${group.createdAt}` : group.id)}
					<div class="border-l-2 pl-3 {group.summarized ? 'border-line' : 'border-accent/50'}">
						<div class="mb-1.5 flex items-center gap-2 text-[10px] text-faint">
							<span>{fmtDate(group.createdAt)} · {relativeTime(group.createdAt)}</span>
							{#if group.summarized}
								<span class="rounded-full border border-line px-1.5 py-0.5 uppercase tracking-wide">folded into memory</span>
							{:else}
								<span class="rounded-full border border-accent/40 bg-accent-soft px-1.5 py-0.5 uppercase tracking-wide text-accent">current</span>
							{/if}
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
									editable={!group.summarized && !msg.pending && group.id > 0}
									onedit={saveEdit}
									ondelete={deleteMessage}
								/>
							{/each}
						</div>
					</div>
				{/each}
				{#if app.sending && !app.stream.some((g) => g.messages.some((m) => m.pending))}
					<div class="text-xs text-faint">thinking…</div>
				{/if}
			</div>
		{/if}
	</div>
	<Composer bind:this={composerRef} onsend={app.sendMessage} />
</div>

<ConfirmModal
	open={deleteGroup !== null}
	title="Delete conversation"
	body="Delete this whole conversation? If it was already folded into memory, the memory keeps its content."
	onconfirm={deleteConversation}
	onclose={() => (deleteGroup = null)}
/>
