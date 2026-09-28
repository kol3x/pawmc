<script lang="ts">
import { app } from "../lib/appState.svelte"
import { settings } from "../lib/settings.svelte"
import { pushToast } from "../lib/toasts.svelte"
import IconButton from "./ui/IconButton.svelte"

interface Props {
	/** Called with the message text; returns true when the send succeeded (draft not restored). */
	onsend: (text: string, noteMode: boolean, categoryName?: string) => Promise<boolean>
}

/**
 * Message composer: auto-growing textarea, note mode, fullscreen long-text mode,
 * and new-category/new-topic fields when nothing (or a fresh topic) is selected.
 */
let { onsend }: Props = $props()

let draft = $state("")
let noteMode = $state(false)
let newCategoryName = $state("")
let textareaEl = $state<HTMLTextAreaElement | null>(null)

const needsCategory = $derived(!app.selectedCategory)
const needsTopic = $derived(app.newTopicMode || !app.selectedTopic)

export function focus() {
	textareaEl?.focus()
}

function autoGrow() {
	const el = textareaEl
	if (!el) return
	el.style.height = "auto"
	el.style.height = Math.min(el.scrollHeight, 160) + "px"
}

function onKeydown(e: KeyboardEvent) {
	if (e.isComposing) return
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault()
		void send()
	}
}

function fullscreenKeydown(e: KeyboardEvent) {
	if (e.isComposing) return
	if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
		e.preventDefault()
		void send()
	}
}

function closeFullscreen() {
	settings.fullscreenComposer = false
	textareaEl?.focus()
}

async function send() {
	const text = draft.trim()
	if (!text || app.sending) return
	const categoryName = needsCategory ? newCategoryName.trim() : undefined
	if (needsCategory && !categoryName) {
		pushToast("Type a category name first", "error")
		return
	}
	draft = ""
	if (textareaEl) textareaEl.style.height = "auto"

	const ok = await onsend(text, noteMode, categoryName)
	if (!ok) {
		draft = text
		autoGrow()
	} else if (needsCategory) {
		newCategoryName = ""
	}
}

</script>
<div class="border-t border-line bg-panel/60 p-3">
	{#if needsCategory || needsTopic}
		<div class="mb-2 flex flex-wrap gap-2">
			{#if needsCategory}
				<input
					placeholder="New category name"
					bind:value={newCategoryName}
					class="h-9 min-w-36 flex-1 rounded-lg border border-line bg-bg px-3 text-sm placeholder:text-faint focus:border-accent focus:outline-none"
				/>
			{/if}
			{#if needsTopic}
				<div class="relative flex min-w-36 flex-1 items-center">
					<input
						placeholder="Topic name (blank = auto)"
						bind:value={app.draftTopicName}
						class="h-9 w-full rounded-lg border border-line bg-bg px-3 text-sm placeholder:text-faint focus:border-accent focus:outline-none"
					/>
					{#if app.newTopicMode && app.selectedTopic}
						<button
							class="absolute right-2 text-[10px] text-faint hover:text-ink"
							onclick={() => (app.newTopicMode = false)}
							title="Cancel new topic"
						>cancel</button>
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	<div class="flex items-end gap-2">
		<button
			class="flex h-9 items-center rounded-lg border px-2.5 text-xs font-medium transition-colors {noteMode
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
				rows="1"
				placeholder={noteMode ? "Save a note (no AI response)…" : "Type a message…"}
				class="max-h-40 w-full resize-none rounded-xl border border-line bg-bg px-3.5 py-2.5 pr-16 text-sm leading-relaxed placeholder:text-faint focus:border-accent focus:outline-none"
			></textarea>
			<div class="absolute bottom-2 right-2.5 text-[10px] leading-none text-faint">
				{#if app.sending}
					<svg class="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.6" /></svg>
				{:else}
					Enter
				{/if}
			</div>
		</div>
		<IconButton title="Fullscreen composer" onclick={() => (settings.fullscreenComposer = true)}>
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
		</IconButton>
		<button
			class="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
			disabled={!draft.trim() || app.sending}
			onclick={() => void send()}
			aria-label="Send"
		>
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>
		</button>
	</div>
	<div class="mt-1.5 hidden justify-between px-1 text-[10px] text-faint sm:flex">
		<span>Enter to send · Shift+Enter for a new line</span>
		<span>/ to focus</span>
	</div>
</div>

{#if settings.fullscreenComposer}
	<div class="fixed inset-0 z-[65] flex flex-col bg-bg p-4">
		<div class="flex items-center justify-between pb-3">
			<h2 class="text-sm font-semibold">Compose</h2>
			<div class="flex items-center gap-2">
				<button
					class="flex h-9 items-center rounded-lg border px-2.5 text-xs font-medium transition-colors {noteMode
						? 'border-accent bg-accent-soft text-accent'
						: 'border-line text-dim hover:text-ink'}"
					onclick={() => (noteMode = !noteMode)}
				>Note</button>
				<IconButton title="Close" onclick={closeFullscreen}>
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
				</IconButton>
			</div>
		</div>
		<textarea
			bind:value={draft}
			onkeydown={fullscreenKeydown}
			placeholder={noteMode ? "Save a note (no AI response)…" : "Type a message…"}
			class="flex-1 resize-none rounded-xl border border-line bg-panel p-4 text-base leading-relaxed focus:border-accent focus:outline-none"
		></textarea>
		<div class="flex items-center justify-between pt-3 text-[10px] text-faint">
			<span>Ctrl/Cmd+Enter to send · Esc to close</span>
			<button
				class="h-10 rounded-lg bg-accent px-5 text-sm font-medium text-white hover:bg-accent/85 disabled:opacity-40"
				disabled={!draft.trim() || app.sending}
				onclick={() => void send()}
			>Send</button>
		</div>
	</div>
{/if}
