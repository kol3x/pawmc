<script lang="ts">
import Modal from "./ui/Modal.svelte"

interface Props {
	open: boolean
	title: string
	body: string
	confirmLabel?: string
	danger?: boolean
	onconfirm: () => void
	onclose: () => void
}

/**
 * Confirmation modal used for destructive actions (deletes, forget).
 */
let {
	open,
	title,
	body,
	confirmLabel = "Delete",
	danger = true,
	onconfirm,
	onclose,
}: Props = $props()

</script>
<Modal {title} {open} {onclose}>
	<p class="text-sm text-dim">{body}</p>
	<div class="mt-4 flex justify-end gap-2">
		<button
			class="h-9 rounded-lg border border-line px-3.5 text-sm text-dim hover:bg-panel-2 hover:text-ink"
			onclick={onclose}>Cancel</button
		>
		<button
			class="h-9 rounded-lg px-3.5 text-sm font-medium text-white {danger
				? 'bg-danger hover:bg-danger/85'
				: 'bg-accent hover:bg-accent/85'}"
			onclick={() => {
				onclose()
				onconfirm()
			}}>{confirmLabel}</button
		>
	</div>
</Modal>
