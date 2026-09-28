<script lang="ts">
import { toasts, dismissToast, type ToastKind } from "../../lib/toasts.svelte"

/**
 * Fixed toast stack at the bottom center of the screen.
 */
const colors: Record<ToastKind, string> = {
	info: "border-line text-ink",
	success: "border-fresh/50 text-ink",
	error: "border-danger/60 text-ink",
}

</script>
<div class="pointer-events-none fixed inset-x-0 bottom-16 z-[60] flex flex-col items-center gap-2 px-4">
	{#each toasts.list as toast (toast.id)}
		<button
			class="pointer-events-auto max-w-md rounded-lg border bg-panel px-4 py-2 text-xs shadow-xl {colors[toast.kind]}"
			onclick={() => dismissToast(toast.id)}
		>
			{toast.msg}
		</button>
	{/each}
</div>
