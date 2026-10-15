<script lang="ts">
import { app } from "../lib/appState.svelte"

interface Props {
	/** Called with the message text; returns true when the send succeeded (draft not restored). */
	onsend: (text: string, noteMode: boolean, categoryName?: string) => Promise<boolean>
}

/**
 * Message composer: auto-growing textarea (generously sized by default) with two send buttons
 * anchored to opposite ends of the composer's right edge — "Send" at the bottom posts a normal
 * message, "Send note" at the top posts it as a kept-as-context note with no reply (also via
 * Ctrl/Cmd+Enter, no mouse needed). On touch devices the keyboard has no Shift/Ctrl, so Enter
 * falls through to its default newline behavior and sending happens only via the buttons.
 * Category and topic naming live in the header's tab/chip rows; the composer only sends.
 */
let { onsend }: Props = $props()

let draft = $state("")
let textareaEl = $state<HTMLTextAreaElement | null>(null)

/** Macs use Cmd+Enter for the note keybind — plain Ctrl+Enter opens the context menu there. */
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const noteKeyHint = isMac ? "⌘+Enter" : "Ctrl+Enter"

/** Touch-primary devices: the virtual keyboard has no Shift/Ctrl, so Enter must stay a newline. */
const isCoarse = window.matchMedia("(pointer: coarse)").matches

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
	if (isCoarse) return
	if (e.isComposing) return
	if (e.key !== "Enter" || e.shiftKey) return
	const wantsNote = isMac ? e.metaKey : e.ctrlKey
	if (wantsNote || (!e.ctrlKey && !e.metaKey)) {
		e.preventDefault()
		void send(wantsNote)
	}
}

/** Sends the draft; note mode keeps it as context without triggering a reply. */
async function send(noteMode = false) {
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
		<div class="relative flex-1">
			<textarea
				bind:this={textareaEl}
				bind:value={draft}
				oninput={autoGrow}
				onkeydown={onKeydown}
				rows="4"
				placeholder="What's on your mind…"
				class="block max-h-72 min-h-24 w-full resize-none rounded-xl border border-line bg-bg px-3.5 py-2.5 pr-16 text-base leading-relaxed placeholder:text-faint focus:border-accent focus:outline-none"
			></textarea>
			<div class="absolute bottom-2 right-2.5 text-[10px] leading-none text-faint">
				{#if app.sending}
					<svg class="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.6" /></svg>
				{:else if !isCoarse}
					Enter
				{/if}
			</div>
		</div>
		<div class="flex shrink-0 flex-col justify-between gap-1.5 self-stretch">
			<button
				class="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-dim transition-colors hover:border-accent hover:text-ink disabled:opacity-40"
				disabled={!draft.trim() || app.sending}
				onclick={() => void send(true)}
				aria-label="Send note"
				title="Save as a note — kept as context, no reply ({noteKeyHint})"
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
			</button>
			<button
				class="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
				disabled={!draft.trim() || app.sending}
				onclick={() => void send(false)}
				aria-label="Send"
				title="Send a message and get a reply (Enter)"
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>
			</button>
		</div>
	</div>
	<div class="mt-1.5 hidden px-1 text-[10px] text-faint sm:flex">
		{#if !isCoarse}
			<span>Enter to send · {noteKeyHint} to send a note · Shift+Enter for a new line</span>
		{/if}
	</div>
</div>
