<script lang="ts">
	import { auth, initAuth } from "./lib/auth.svelte"
	import { initSettings } from "./lib/settings.svelte"
	import { app } from "./lib/appState.svelte"
	import { api, ApiError } from "./api"
	import { pushToast } from "./lib/toasts.svelte"
	import type { CategorySummary, TopicSummary } from "./api-types"
	import Sidebar from "./components/Sidebar.svelte"
	import ChatPane from "./components/ChatPane.svelte"
	import ContextView from "./components/ContextView.svelte"
	import AuthOverlay from "./components/AuthOverlay.svelte"
	import SettingsModal from "./components/SettingsModal.svelte"
	import PromptModal from "./components/PromptModal.svelte"
	import ConfirmModal from "./components/ConfirmModal.svelte"
	import ToastHost from "./components/ui/ToastHost.svelte"
	import IconButton from "./components/ui/IconButton.svelte"

	initAuth()
	initSettings()

	let drawerOpen = $state(false)
	let settingsOpen = $state(false)
	let composerRef = $state<ChatPane | null>(null)

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
			window.removeEventListener("focus", onFocus)
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

	const breadcrumb = $derived.by(() => {
		const cat = app.selectedCategory
		if (app.newTopicMode) return cat ? `${cat.name} / new topic` : "new conversation"
		const topic = app.selectedTopic
		if (cat && topic) return `${cat.name} / ${topic.name}`
		return cat?.name ?? ""
	})
</script>

{#if showAuth}
	<AuthOverlay />
{:else}
	<div class="flex h-dvh overflow-hidden">
		<!-- mobile drawer backdrop -->
		{#if drawerOpen}
			<button
				class="fixed inset-0 z-30 cursor-default appearance-none bg-black/50 lg:hidden"
				aria-label="Close menu"
				tabindex="-1"
				onclick={() => (drawerOpen = false)}
			></button>
		{/if}
		<div
			class="fixed inset-y-0 left-0 z-40 transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 {drawerOpen
				? 'translate-x-0'
				: '-translate-x-full'}"
		>
			<Sidebar
				onclose={() => (drawerOpen = false)}
				onrenamecategory={onRenameCategory}
				ondeletecategory={onDeleteCategory}
				onrenametopic={onRenameTopic}
				ondeletetopic={onDeleteTopic}
				onsettings={() => (settingsOpen = true)}
			/>
		</div>

		<div class="flex min-w-0 flex-1 flex-col">
			<header class="flex items-center gap-2 border-b border-line bg-panel/60 px-3 py-2.5">
				<IconButton title="Menu" onclick={() => (drawerOpen = true)} class="lg:hidden">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
				</IconButton>
				<h1 class="min-w-0 flex-1 truncate text-sm font-medium">{breadcrumb}</h1>
				<div class="flex overflow-hidden rounded-lg border border-line text-xs">
					<button
						class="px-3 py-1.5 font-medium transition-colors {app.view === 'chat'
							? 'bg-accent-soft text-accent'
							: 'text-dim hover:text-ink'}"
						onclick={() => (app.view = "chat")}
					>Chat</button>
					<button
						class="px-3 py-1.5 font-medium transition-colors {app.view === 'context'
							? 'bg-accent-soft text-accent'
							: 'text-dim hover:text-ink'}"
						onclick={() => (app.view = "context")}
					>Context</button>
				</div>
			</header>

			{#if app.view === "chat"}
				<ChatPane bind:this={composerRef} />
			{:else}
				<ContextView />
			{/if}
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
