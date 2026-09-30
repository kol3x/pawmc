<script lang="ts">
import { app } from "../lib/appState.svelte"

interface Props {
	/** Called with the parked draft when the user cancels the pick. */
	oncancel: (draft: string) => void
}

/**
 * Candidate picker shown when a send was parked by the autotopic confidence gate (422):
 * one-click topic choices plus a custom topic name; picking resends the parked draft.
 */
let { oncancel }: Props = $props()

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
	<div class="border-b border-accent/30 bg-accent-soft/50 px-4 py-3">
		<p class="mb-2 text-xs text-dim">Nothing saved yet — where does this belong?</p>
		<div class="flex flex-wrap gap-1.5">
			{#each app.topicNeeded.candidates as c (c.name)}
				<button
					class="flex max-w-full items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-xs transition-colors hover:border-accent/50 hover:text-ink"
					onclick={() => void app.pickTopicAndResend(c.name)}
				>
					<span class="font-medium">{c.name}</span>
					{#if c.description}
						<span class="truncate text-faint">{c.description}</span>
					{/if}
					{#if c.exists}
						<span class="rounded-full border border-line px-1.5 text-[10px] uppercase tracking-wide text-faint">existing</span>
					{/if}
				</button>
			{/each}
		</div>
		<div class="mt-2 flex gap-2">
			<input
				placeholder="Or type a topic name…"
				bind:value={customName}
				onkeydown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault()
						useCustom()
					}
				}}
				class="h-8 flex-1 max-w-xs rounded-lg border border-line bg-bg px-3 text-xs placeholder:text-faint focus:border-accent focus:outline-none"
			/>
			<button
				class="h-8 rounded-lg bg-accent px-3 text-xs font-medium text-white hover:bg-accent/85 disabled:opacity-40"
				disabled={!customName.trim()}
				onclick={useCustom}
			>Use</button>
			<button class="h-8 rounded-lg border border-line px-3 text-xs text-dim hover:text-ink" onclick={cancel}>Cancel</button>
		</div>
	</div>
{/if}