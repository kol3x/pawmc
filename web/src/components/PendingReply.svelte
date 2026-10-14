<script lang="ts">
import { app } from "../lib/appState.svelte"

interface Props {
	/** Called with the draft when the user cancels a parked topic pick. */
	oncancel: (draft: string) => void
}

/**
 * Assistant-side stand-in for the reply bubble, and the home of all topic-pick UI:
 * while POST /topic runs it shows a dashed "Picking a topic…" placeholder; on the 422
 * confidence gate it becomes the candidate picker (chips + custom name + cancel) right
 * under the parked message; while POST /chat generates it shows "Writing…" with the
 * resolved topic as a chip. Mirrors the assistant bubble geometry so nothing jumps when
 * the real reply replaces it; renders nothing while idle.
 */
let { oncancel }: Props = $props()

const inFlight = $derived(app.sending && app.pendingPhase)
const label = $derived(
	app.pendingPhase === "topic" ? "Picking a topic…" : app.pendingTopic ? `Replying on ${app.pendingTopic}` : "Writing…",
)

let customName = $state("")

function useCustom() {
	const name = customName.trim()
	if (!name) return
	customName = ""
	void app.pickTopicAndResend(name)
}

function cancel() {
	customName = ""
	const draft = app.cancelTopicNeeded()
	if (draft) oncancel(draft)
}
</script>

{#if app.topicNeeded}
	<div class="flex gap-2.5">
		<div class="mt-0.5 flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full bg-panel-2 text-[10px] font-semibold text-dim">
			AI
		</div>
		<div class="w-full max-w-xl rounded-2xl rounded-bl-md border border-dashed border-accent/60 bg-accent-soft/40 px-3.5 py-2.5">
			<p class="text-xs text-dim">Nothing saved yet — where does this belong?</p>
			<div class="mt-2 flex flex-wrap gap-1.5">
				{#each app.topicNeeded.candidates as c (c.name)}
					<button
						class="flex max-w-full items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-xs transition-colors hover:border-accent/50 hover:text-ink"
						onclick={() => void app.pickTopicAndResend(c.name)}
					>
						<span class="font-medium">{c.name}</span>
						{#if c.exists}
							<span class="rounded-full border border-line px-1.5 text-[10px] uppercase tracking-wide text-faint">existing</span>
						{/if}
					</button>
				{/each}
			</div>
			<div class="mt-2.5 flex items-center gap-2">
				<input
					placeholder="Or type a topic name…"
					bind:value={customName}
					onkeydown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault()
							useCustom()
						}
					}}
					class="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-xs placeholder:text-faint focus:border-accent focus:outline-none"
				/>
				<button class="shrink-0 text-xs text-dim hover:text-ink" onclick={cancel}>Cancel</button>
			</div>
		</div>
	</div>
{:else if inFlight}
	<div class="flex gap-2.5">
		<div class="mt-0.5 flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full bg-panel-2 text-[10px] font-semibold text-dim">
			AI
		</div>
		<div class="flex min-w-0 max-w-[85%] flex-col items-start gap-1">
			<div
				class="flex items-center gap-2.5 rounded-2xl rounded-bl-md px-3.5 py-2.5 text-dim {app.pendingPhase === 'topic'
					? 'border border-dashed border-accent/50'
					: 'border border-line bg-panel'}"
			>
				<svg class="shrink-0 animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.6" /></svg>
				<span class="truncate text-sm leading-relaxed md:text-base">{label}</span>
			</div>
		</div>
	</div>
{/if}
