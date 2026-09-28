<script lang="ts">
import { app } from "../lib/appState.svelte"

interface Props {
	/** Called with the message text; returns true when the send succeeded (draft not restored). */
	onsend: (text: string, noteMode: boolean, categoryName?: string) => Promise<boolean>
}

/**
 * Message composer: auto-growing textarea (generously sized by default) plus note mode.
 * Category and topic naming live in the header's tab/chip rows; the composer only sends.
 */
let { onsend }: Props = $props()

let draft = $state("")
let noteMode = $state(false)
let textareaEl = $state<HTMLTextAreaElement | null>(null)

export function focus() {
	textareaEl?.focus()
}

export function setDraft(text: string) {
	draft = text
	autoGrow()
}

function autoGrow() {
	const el = textareaEl
	if (!el) return
	el.style.height = "auto"
	el.style.height = Math.min(el.scrollHeight, 288) + "px"
}

function onKeydown(e: KeyboardEvent) {
	if (e.isComposing) return
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault()
		void send()
	}
}

async function send() {
	const text = draft.trim()
	if (!text || app.sending) return
	draft = ""
	if (textareaEl) textareaEl.style.height = "auto"

	const ok = await onsend(text, noteMode)
	if (!ok) {
		draft = text
		autoGrow()
	}
}
</script>
<div class="border-t border-line bg-panel/60 p-3">
	<div class="flex items-end gap-2">
		<button
			class="flex h-9 shrink-0 items-center rounded-lg border px-2.5 text-xs font-medium transition-colors {noteMode
				? 'border-accent bg-accent-soft text-accent'
				: 'border-line text-dim hover:text-ink'}"
			onclick={() => (noteMode = !noteMode)}
			aria-pressed={noteMode}
			title="Note mode: save text as context without an AI reply"
		>
			Note
		</button>
		<div class="relative flex-1">
			<textarea
				bind:this={textareaEl}
				bind:value={draft}
				oninput={autoGrow}
				onkeydown={onKeydown}
				rows="4"
				placeholder={noteMode ? "Save a note (no AI response)…" : "Type a message…"}
				class="max-h-72 min-h-24 w-full resize-none rounded-xl border border-line bg-bg px-3.5 py-2.5 pr-16 text-base leading-relaxed placeholder:text-faint focus:border-accent focus:outline-none"
			></textarea>
			<div class="absolute bottom-2 right-2.5 text-[10px] leading-none text-faint">
				{#if app.sending}
					<svg class="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.6" /></svg>
				{:else}
					Enter
				{/if}
			</div>
		</div>
		<button
			class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
			disabled={!draft.trim() || app.sending}
			onclick={() => void send()}
			aria-label="Send"
		>
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>
		</button>
	</div>
	<div class="mt-1.5 hidden px-1 text-[10px] text-faint sm:flex">
		<span>Enter to send · Shift+Enter for a new line</span>
	</div>
</div>