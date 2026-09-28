<script lang="ts">
import type { Snippet } from "svelte"

interface Props {
	title: string
	onclick?: (e: MouseEvent) => void
	disabled?: boolean
	danger?: boolean
	active?: boolean
	class?: string
	children: Snippet
}

/**
 * Small square icon button for toolbars and row actions.
 */
let { title, onclick, disabled = false, danger = false, active = false, class: cls = "", children }: Props = $props()

</script>
<button
	{title}
	{disabled}
	{onclick}
	aria-label={title}
	class="inline-flex h-8 w-8 select-none items-center justify-center rounded-md border border-transparent text-dim transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-40 {danger
		? 'hover:text-danger'
		: ''} {active ? 'text-accent' : ''} {cls}"
>
	{@render children?.()}
</button>
