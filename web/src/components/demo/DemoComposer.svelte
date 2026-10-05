<script lang="ts">
import { app } from "../../lib/appState.svelte"
import { demo } from "../../lib/demo/state.svelte"

/**
 * Composer replacement for demo runs: instead of a textarea it offers the current beat's
 * precomputed message drafts. Picking one sends it through the real send pipeline
 * (optimistic bubble, thinking delay, reply, refresh) exactly like a typed message.
 */

/** Sends a picked draft through the real send pipeline; the demo executor answers it. */
function pick(text: string): void {
	if (app.sending || demo.locked) return
	void app.sendMessage(text, false)
}
</script>

<div class="border-t border-line bg-panel/60 p-3">
	{#if demo.guidance}
		{#key demo.guidance}
			<p class="guidance-chip mb-2 rounded-lg bg-accent-soft px-3 py-2 text-sm leading-relaxed text-ink md:text-base">
				{demo.guidance}
			</p>
		{/key}
	{/if}
	{#if demo.phase === "dayPass"}
		<button
			class="h-9 w-full rounded-lg bg-accent text-sm font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
			disabled={app.sending || demo.locked}
			onclick={() => void demo.runDayPass()}
		>
			Continue to tomorrow
		</button>
	{:else if demo.phase === "newConversation"}
		<button
			class="h-9 w-full rounded-lg bg-accent text-sm font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
			disabled={app.sending || demo.locked}
			onclick={() => demo.startNewConversation()}
		>
			Start a new conversation
		</button>
	{:else if demo.phase === "finale"}
		<button
			class="h-9 w-full rounded-lg bg-accent text-sm font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-40"
			disabled={app.sending || demo.locked}
			onclick={() => demo.finish()}
		>
			Continue
		</button>
	{:else if demo.currentOptions.length}
		<div class="flex flex-col gap-1.5">
			{#each demo.currentOptions as option, i (i)}
				<button
					class="rounded-xl border border-line bg-bg px-3.5 py-2.5 text-left text-sm leading-relaxed text-ink transition-colors hover:border-accent/60 disabled:opacity-40"
					disabled={app.sending || demo.locked}
					onclick={() => pick(option)}
				>
					{option}
				</button>
			{/each}
		</div>
	{:else}
		<div class="h-2"></div>
	{/if}
</div>
