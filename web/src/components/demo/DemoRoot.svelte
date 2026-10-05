<script lang="ts">
import { demo, exitDemo, restartDemo } from "../../lib/demo/state.svelte"

/** Link to the repo for the self-deploy call to action. */
const REPO_URL = "https://github.com/kol3x/Pawmc"

/**
 * Self-mounted demo overlay root (mounted by the demo state to a body element): the
 * intro/outro screens, the demo badge with the exit, and the day-pass overlay. Step
 * guidance lives in the composer slot (DemoComposer), directly above the options it
 * refers to. The app shell stays untouched underneath.
 */
</script>

{#if demo.phase === "intro"}
	<div class="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-bg p-6">
		<div class="w-full max-w-md py-8">
			<div class="mb-5 text-center">
				<div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft">
					<div class="h-4 w-4 rounded-full bg-accent"></div>
				</div>
				<h1 class="text-lg font-semibold">pawmc</h1>
			</div>
			<p class="text-sm leading-relaxed text-dim md:text-base">
				This is a guided simulation without an LLM or a database. In the real app you would type
				your own context — here you just go through a hypothetical scenario.
			</p>
			<p class="mt-2 text-sm leading-relaxed text-dim md:text-base">
				pawmc really shines after multiple uses, once memory has accumulated — this walkthrough just shows a single loop.
			</p>
			<button
				class="mt-5 h-10 w-full rounded-lg bg-accent text-sm font-medium text-white transition-colors hover:bg-accent/85"
				onclick={() => demo.beginRun()}
			>
				Start the demo
			</button>
		</div>
	</div>
{/if}

{#if demo.phase !== "intro" && demo.phase !== "outro"}
	<div class="fixed left-1/2 top-1.5 z-40 -translate-x-1/2">
		<div class="flex items-center gap-2 rounded-full border border-line bg-panel/90 px-3 py-1 text-[11px] shadow-sm backdrop-blur">
			<span class="font-medium text-dim">Demo</span>
			<span class="text-faint">simulated data, nothing saved</span>
			<button class="text-accent transition-colors hover:underline" onclick={exitDemo}>Exit</button>
		</div>
	</div>
{/if}

{#if demo.phase === "dayPassing"}
	<div class="fixed inset-0 z-[60] flex items-center justify-center bg-bg/95">
		<div class="flex items-center gap-2 text-sm text-dim">
			<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>
			A day has passed — summarizing your conversations into memory…
		</div>
	</div>
{/if}

{#if demo.phase === "outro"}
	<div class="fixed inset-0 z-[70] overflow-y-auto bg-bg p-6">
		<div class="mx-auto w-full max-w-md py-10">
		<h1 class="text-lg font-semibold">That's the loop</h1>
	<ul class="mt-3 flex flex-col gap-2 text-sm leading-relaxed text-dim md:text-base">
			<li>In the real app you type your own context — the diary, the topic, every message. Here you picked drafts replaying a common hypothetical.</li>
			<li>Each day, conversations are summarized into memory you can read, revise, or erase.</li>
		</ul>
			<a
				class="mt-5 flex h-10 items-center justify-center rounded-lg bg-accent text-sm font-medium text-white transition-colors hover:bg-accent/85"
				href={REPO_URL}
				target="_blank"
				rel="noopener noreferrer"
			>
				Deploy your own pawmc
			</a>
			<div class="mt-2 flex gap-2">
				<button
				class="h-9 flex-1 rounded-lg border border-line text-sm text-dim transition-colors hover:bg-panel-2 hover:text-ink"
				onclick={restartDemo}
				>
					Restart demo
				</button>
				<button
				class="h-9 flex-1 rounded-lg border border-line text-sm text-dim transition-colors hover:bg-panel-2 hover:text-ink"
				onclick={exitDemo}
				>
					Exit
				</button>
			</div>
		</div>
	</div>
{/if}
