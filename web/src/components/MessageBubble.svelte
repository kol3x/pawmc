<script lang="ts">
import { type StreamMessage } from "../lib/appState.svelte"
import { renderMarkdown } from "../lib/markdown"
import Menu from "./Menu.svelte"

interface Props {
	msg: StreamMessage
	/** True when the message may be edited (user messages in unsummarized conversations only). */
	canEdit: boolean
	/** True when the message may be deleted (any role in unsummarized conversations). */
	canMutate: boolean
	onedit: (msg: StreamMessage, content: string) => void
	ondelete: (msg: StreamMessage) => void
}

/**
 * One message in the continuous stream: avatar, bubble (markdown for assistant), and
 * actions — editing is limited to the user's own messages; deletion works on both roles
 * while the conversation is not yet summarized.
 */
let { msg, canEdit, canMutate, onedit, ondelete }: Props = $props()

let editing = $state(false)
let editText = $state("")

function startEdit() {
	editText = msg.content
	editing = true
}

function saveEdit() {
	const trimmed = editText.trim()
	editing = false
	if (trimmed && trimmed !== msg.content) onedit(msg, trimmed)
}

const html = $derived(renderMarkdown(msg.content))

</script>
<div class="group/msg flex gap-2.5 {msg.role === 'user' ? 'flex-row-reverse' : ''}">
	<div
		class="mt-0.5 flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full text-[10px] font-semibold {msg.role === 'user'
			? 'bg-accent text-white'
			: 'bg-panel-2 text-dim'}"
	>
		{msg.role === "user" ? "U" : "AI"}
	</div>
	<div class="flex min-w-0 max-w-[85%] flex-col gap-1 {msg.role === 'user' ? 'items-end' : 'items-start'}">
		{#if editing}
			<div class="w-72 max-w-full rounded-xl border border-accent/60 bg-panel p-2 sm:w-96">
				<textarea
					bind:value={editText}
					rows="4"
					class="w-full resize-y bg-transparent text-sm text-ink focus:outline-none md:text-base"
				></textarea>
				<div class="mt-1.5 flex justify-end gap-2 text-xs">
					<button class="rounded-md px-2 py-1 text-dim hover:text-ink" onclick={() => (editing = false)}>Cancel</button>
					<button class="rounded-md bg-accent px-2.5 py-1 font-medium text-white hover:bg-accent/85" onclick={saveEdit}>Save</button>
				</div>
			</div>
		{:else}
			<div
				class="rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed md:text-base {msg.role === 'user'
					? 'rounded-br-md bg-accent text-white'
					: 'rounded-bl-md bg-panel border border-line text-ink'}"
			>
				{#if msg.role === "user"}
					<div class="whitespace-pre-wrap">{msg.content}</div>
				{:else}
					<div class="md">{@html html}</div>
				{/if}
				{#if msg.pending}
					<div class="mt-1 text-[10px] opacity-70">sending…</div>
				{/if}
			</div>
		{/if}
		{#if canMutate && !editing}
			<Menu label="Message actions" items={[
				...(canEdit ? [{ label: "Edit", onpick: startEdit }] : []),
				{ label: "Delete", danger: true, onpick: () => ondelete(msg) },
			]}>
				<svg class="opacity-30 transition-opacity group-hover/msg:opacity-100" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
			</Menu>
		{/if}
	</div>
</div>
