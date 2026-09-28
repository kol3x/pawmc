<script lang="ts">
	import { auth, initAuth } from "./lib/auth.svelte"
	import { app } from "./lib/appState.svelte"
	import { api, ApiError } from "./api"
	import { pushToast } from "./lib/toasts.svelte"
	import type { CategorySummary, TopicSummary } from "./api-types"
	import CategoryTabs from "./components/CategoryTabs.svelte"
	import TopicChips from "./components/TopicChips.svelte"
	import ChatPane from "./components/ChatPane.svelte"
	import MemoryBar from "./components/MemoryBar.svelte"
	import AuthOverlay from "./components/AuthOverlay.svelte"
	import SettingsModal from "./components/SettingsModal.svelte"
	import PromptModal from "./components/PromptModal.svelte"
	import ConfirmModal from "./components/ConfirmModal.svelte"
	import ToastHost from "./components/ui/ToastHost.svelte"
	import IconButton from "./components/ui/IconButton.svelte"

	initAuth()

	let settingsOpen = $state(false)
	let memoryOpen = $state(false)
	let composerRef = $state<ChatPane | null>(null)

	// Escape closes the mobile memory drawer.
	$effect(() => {
		if (!memoryOpen) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") memoryOpen = false
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	})

	let promptConfig = $state<null | {
		title: string
		initial: string
		submitLabel?: string
		submit: (value: string) => Promise<void>
	}>(null)
	let confirmConfig = $state<null | { title: string; body: string; confirm: () => Promise<void> }>(null)

	let booted = false

	$effect(() => {
		// auth.invalid is read so re-saving a rejected key re-triggers the boot.
		void auth.invalid
		if (auth.key && !booted) {
			booted = true
			void app
				.loadCategories()
				.then(() => {
					app.restoreFromUrl()
					return app.loadStream()
				})
				.catch((err) => {
					booted = false
					if (err instanceof ApiError && err.status === 401) return
					pushToast(`Couldn't load — ${err instanceof Error ? err.message : String(err)}`, "error")
				})
		}
	})

	// Keep ?category=&topic= in sync with the selection.
	$effect(() => {
		const cat = app.selectedCategory?.name ?? ""
		const topic = app.selectedTopic?.name ?? ""
		const params = new URLSearchParams()
		if (cat) params.set("category", cat)
		if (topic) params.set("topic", topic)
		const query = params.toString()
		window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname)
	})

	// Reconcile interrupted chats and refresh stale data when the tab regains visibility.
	$effect(() => {
		const onVisible = () => {
			if (document.visibilityState === "visible") void app.recover()
		}
		const onFocus = () => void app.recover()
		document.addEventListener("visibilitychange", onVisible)
		window.addEventListener("focus", onFocus)
		window.addEventListener("pageshow", onFocus)
		return () => {
			document.removeEventListener("visibilitychange", onVisible)
			document.removeEventListener("focus", onFocus)
			window.removeEventListener("pageshow", onFocus)
		}
	})

	// "/" focuses the composer when the user isn't already typing.
	$effect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target
			const typing =
				target instanceof HTMLElement &&
				(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
			if (e.key === "/" && !typing && !settingsOpen) {
				e.preventDefault()
				composerRef?.focusComposer()
			}
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	})

	const showAuth = $derived(auth.key === "" || auth.invalid)

	function renameEntity(
		title: string,
		initial: string,
		run: (name: string) => Promise<void>,
	) {
		promptConfig = { title, initial, submit: run }
	}

	function onRenameCategory(cat: CategorySummary) {
		renameEntity("Rename category", cat.name, async (name) => {
			try {
				await api("POST", "/rename-category", { id: cat.id, name })
				await app.loadCategories()
				pushToast("Category renamed", "success")
			} catch (err) {
				pushApiError(err, "rename")
			}
		})
	}

	function onRenameTopic(topic: TopicSummary) {
		renameEntity("Rename topic", topic.name, async (name) => {
			try {
				await api("POST", "/rename-topic", { id: topic.id, name })
				await app.loadCategories()
				pushToast("Topic renamed", "success")
			} catch (err) {
				pushApiError(err, "rename")
			}
		})
	}

	function onDeleteCategory(cat: CategorySummary) {
		confirmConfig = {
			title: "Delete category",
			body: `Delete "${cat.name}" with all its topics and conversations? This cannot be undone.`,
			confirm: async () => {
				try {
					await api("DELETE", `/category?id=${cat.id}`)
					await app.loadCategories()
					await app.loadStream()
					pushToast("Category deleted", "success")
				} catch (err) {
					pushApiError(err, "delete")
				}
			},
		}
	}

	function onDeleteTopic(topic: TopicSummary) {
		confirmConfig = {
			title: "Delete topic",
			body: `Delete "${topic.name}" and all its conversations? This cannot be undone.`,
			confirm: async () => {
				try {
					await api("DELETE", `/topic?id=${topic.id}`)
					await app.loadCategories()
					await app.loadStream()
					pushToast("Topic deleted", "success")
				} catch (err) {
					pushApiError(err, "delete")
				}
			},
		}
	}

	/**
	 * Maps API failures on v2 management endpoints to user-friendly toasts, flagging missing backend support.
	 */
	function pushApiError(err: unknown, action: string) {
		if (err instanceof ApiError && err.status === 404)
			pushToast(`${action[0].toUpperCase()}${action.slice(1)} needs a backend update (v2)`, "error")
		else pushToast(`${action} failed — ${err instanceof Error ? err.message : String(err)}`, "error")
	}
</script>

{#if showAuth}
	<AuthOverlay />
{:else}
	<div class="flex h-dvh flex-col overflow-hidden">
		<header class="border-b border-line bg-panel/60 pt-2">
			<div class="flex items-center gap-1">
				<h1 class="shrink-0 pl-4 pr-1 text-sm font-semibold tracking-tight">pawmc</h1>
				<div class="min-w-0 flex-1">
					<CategoryTabs
						onrenamecategory={onRenameCategory}
						ondeletecategory={onDeleteCategory}
					/>
				</div>
			<div class="flex shrink-0 items-center gap-0.5 pr-2">
				<IconButton title="Memory" class="md:hidden" onclick={() => (memoryOpen = true)}>
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
				</IconButton>
				<IconButton title="Settings" onclick={() => (settingsOpen = true)}>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
					</IconButton>
				</div>
			</div>
			{#if app.selectedCategory}
				<div class="min-w-0">
					<TopicChips onrenametopic={onRenameTopic} ondeletetopic={onDeleteTopic} />
				</div>
			{/if}
		</header>

		<ChatPane bind:this={composerRef} />
	</div>
{/if}

{#if memoryOpen}
	<div class="fixed inset-0 z-50 flex md:hidden">
		<button
			class="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
			aria-label="Close memory"
			tabindex="-1"
			onclick={() => (memoryOpen = false)}
		></button>
		<div class="relative flex w-80 max-w-[85vw] flex-col border-r border-line bg-bg shadow-2xl">
			<MemoryBar onclose={() => (memoryOpen = false)} />
		</div>
	</div>
{/if}

<SettingsModal open={settingsOpen} onclose={() => (settingsOpen = false)} />

{#if promptConfig}
	<PromptModal
		open
		title={promptConfig.title}
		initial={promptConfig.initial}
		onclose={() => (promptConfig = null)}
		onsubmit={async (value: string) => {
			const run = promptConfig?.submit
			promptConfig = null
			await run?.(value)
		}}
	/>
{/if}

{#if confirmConfig}
	<ConfirmModal
		open
		title={confirmConfig.title}
		body={confirmConfig.body}
		onclose={() => (confirmConfig = null)}
		onconfirm={() => void confirmConfig?.confirm()}
	/>
{/if}

<ToastHost />