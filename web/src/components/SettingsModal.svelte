<script lang="ts">
	import Modal from "./Modal.svelte"
	import { auth, saveKey, pushToast, theme, setTheme, type ThemePref } from "../lib/appState.svelte"

	interface Props {
		open: boolean
		onclose: () => void
	}

	/**
	 * Settings: theme, API key management, and the keyboard shortcut cheat sheet.
	 */
	let { open, onclose }: Props = $props()

	let value = $state("")

	const THEME_OPTIONS: ThemePref[] = ["system", "dark", "light"]
	const THEME_LABELS: Record<ThemePref, string> = {
		system: "System",
		dark: "Dark",
		light: "Light",
	}

$effect(() => {
	if (open) value = auth.key
})

function save() {
	saveKey(value)
	if (!auth.key) pushToast("API key cleared — reload to re-enter it", "info")
	else pushToast("API key saved", "success")
	onclose()
}

</script>
<Modal title="Settings" {open} {onclose}>
	<div class="flex flex-col gap-5">
		<div class="flex flex-col gap-2">
			<span class="text-xs font-medium text-dim">Theme</span>
			<div class="flex gap-1">
				{#each THEME_OPTIONS as pref (pref)}
					<button
						class="flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors {theme.pref === pref
							? 'border-accent/50 bg-accent-soft text-accent'
							: 'border-line text-dim hover:bg-panel-2 hover:text-ink'}"
						onclick={() => setTheme(pref)}
					>
						{THEME_LABELS[pref]}
					</button>
				{/each}
			</div>
		</div>

		<div class="flex flex-col gap-2">
			<label class="text-xs font-medium text-dim" for="settings-key">API key</label>
			<div class="flex gap-2">
				<input
					id="settings-key"
					type="password"
					autocomplete="off"
					placeholder="API key"
					bind:value
					class="h-10 flex-1 rounded-lg border border-line bg-bg px-3 text-sm focus:border-accent focus:outline-none"
				/>
				<button
					class="h-10 rounded-lg bg-accent px-3.5 text-sm font-medium text-white hover:bg-accent/85"
					onclick={save}>Save</button
				>
			</div>
			<p class="text-[10px] text-faint">Stored locally in this browser only.</p>
		</div>

		<div class="flex flex-col gap-1.5">
			<span class="text-xs font-medium text-dim">Keyboard shortcuts</span>
			<ul class="flex flex-col gap-1 text-xs text-faint">
				<li><span class="text-ink">Enter</span> send · <span class="text-ink">Shift+Enter</span> new line</li>
				<li><span class="text-ink">/</span> focus composer · <span class="text-ink">Esc</span> close overlays</li>
			</ul>
		</div>
	</div>
</Modal>
