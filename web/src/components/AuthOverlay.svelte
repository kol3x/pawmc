<script lang="ts">
import { auth, saveKey } from "../lib/auth.svelte"
import { app } from "../lib/appState.svelte"

/**
 * Full-screen API key entry shown when no key is stored or the key was rejected with 401.
 */
let value = $state("")

async function submit(e: SubmitEvent) {
	e.preventDefault()
	saveKey(value)
	if (auth.key) {
		try {
			await app.loadCategories()
		} catch {
			// Errors surface via toasts / auth.invalid.
		}
	}
}

</script>
<div class="fixed inset-0 z-[70] flex items-center justify-center bg-bg p-6">
	<form class="w-full max-w-xs" onsubmit={submit}>
		<div class="mb-6 text-center">
			<div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft">
				<div class="h-4 w-4 rounded-full bg-accent"></div>
			</div>
			<h1 class="text-lg font-semibold">pawmc</h1>
			<p class="mt-1 text-xs text-dim">
				{auth.invalid ? "API key rejected — check it and try again" : "Enter your API key to continue"}
			</p>
		</div>
		<input
			type="password"
			autocomplete="current-password"
			placeholder="Bearer token"
			bind:value
			class="h-10 w-full rounded-lg border border-line bg-panel px-3 text-sm focus:border-accent focus:outline-none"
		/>
		<button
			type="submit"
			disabled={!value.trim()}
			class="mt-3 h-10 w-full rounded-lg bg-accent text-sm font-medium text-white hover:bg-accent/85 disabled:opacity-40"
		>
			Unlock
		</button>
	</form>
</div>
