<script lang="ts">
import Modal from "./ui/Modal.svelte"
import { auth, saveKey } from "../lib/auth.svelte"
import { pushToast } from "../lib/toasts.svelte"

interface Props {
	open: boolean
	onclose: () => void
}

/**
 * Settings: API key management and the keybind cheat sheet.
 */
let { open, onclose }: Props = $props()

let value = $state("")

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
			<label class="text-xs font-medium text-dim" for="settings-key">API key</label>
			<div class="flex gap-2">
				<input
					id="settings-key"
					type="password"
					autocomplete="off"
					placeholder="Bearer token"
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
			<span class="text-xs font-medium text-dim">Keybinds</span>
			<ul class="flex flex-col gap-1 text-xs text-faint">
				<li><span class="text-ink">Enter</span> send · <span class="text-ink">Shift+Enter</span> new line</li>
				<li><span class="text-ink">Ctrl/Cmd+Enter</span> send in fullscreen composer</li>
				<li><span class="text-ink">/</span> focus composer · <span class="text-ink">Esc</span> close overlays</li>
			</ul>
		</div>
	</div>
</Modal>
