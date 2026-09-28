<script lang="ts">
import Modal from "./ui/Modal.svelte"

interface Props {
	open: boolean
	title: string
	placeholder?: string
	initial?: string
	submitLabel?: string
	onsubmit: (value: string) => void
	onclose: () => void
}

/**
 * Single-text-input modal used for rename and create flows.
 */
let {
	open,
	title,
	placeholder = "",
	initial = "",
	submitLabel = "Save",
	onsubmit,
	onclose,
}: Props = $props()

let value = $state("")
let inputEl = $state<HTMLInputElement | null>(null)

$effect(() => {
	if (open) {
		value = initial
		inputEl?.focus()
	}
})

function submit(e: SubmitEvent) {
	e.preventDefault()
	const trimmed = value.trim()
	if (!trimmed) return
	onsubmit(trimmed)
}

</script>
<Modal {title} {open} {onclose}>
	<form class="flex flex-col gap-3" onsubmit={submit}>
		<input
			bind:this={inputEl}
			bind:value
			{placeholder}
			class="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
		/>
		<div class="flex justify-end gap-2">
			<button
				type="button"
				class="h-9 rounded-lg border border-line px-3.5 text-sm text-dim hover:bg-panel-2 hover:text-ink"
				onclick={onclose}>Cancel</button
			>
			<button
				type="submit"
				class="h-9 rounded-lg bg-accent px-3.5 text-sm font-medium text-white hover:bg-accent/85 disabled:opacity-40"
				disabled={!value.trim()}>{submitLabel}</button
			>
		</div>
	</form>
</Modal>
