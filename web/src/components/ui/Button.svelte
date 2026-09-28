<script lang="ts">
import type { Snippet } from "svelte"

interface Props {
	variant?: "primary" | "ghost" | "danger"
	size?: "sm" | "md"
	type?: "button" | "submit"
	onclick?: (e: MouseEvent) => void
	disabled?: boolean
	title?: string
	children: Snippet
}

/**
 * Standard button used across the app; variants map to the design tokens.
 */
let {
	variant = "ghost",
	size = "md",
	type = "button",
	onclick,
	disabled = false,
	title,
	children,
}: Props = $props()

const sizes = {
	sm: "h-7 px-2.5 text-xs rounded-md",
	md: "h-9 px-3.5 text-sm rounded-lg",
} as const

const variants = {
	primary: "bg-accent text-white hover:bg-accent/85 border border-transparent",
	ghost: "bg-transparent text-dim hover:text-ink hover:bg-panel-2 border border-line",
	danger: "bg-transparent text-danger hover:bg-danger-soft border border-line",
} as const

</script>
<button
	{type}
	{title}
	{disabled}
	{onclick}
	class="inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 {sizes[size]} {variants[variant]}"
>
	{@render children?.()}
</button>
