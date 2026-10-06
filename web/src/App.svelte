<script lang="ts">
	import {
		app,
		auth,
		initAuth,
		pushToast,
		toasts,
		dismissToast,
		type ToastKind,
	} from "./lib/appState.svelte"
	import { ui } from "./lib/uiState.svelte"
	import { api, ApiError, errorMessage, type CategorySummary, type TopicSummary } from "./api"
	import CategoryTabs from "./components/CategoryTabs.svelte"
	import TopicChips from "./components/TopicChips.svelte"
	import ChatPane from "./components/ChatPane.svelte"
	import MemoryBar from "./components/MemoryBar.svelte"
	import AuthOverlay from "./components/AuthOverlay.svelte"
	import SettingsModal from "./components/SettingsModal.svelte"
	import ConfirmModal from "./components/ConfirmModal.svelte"
	import Modal from "./components/Modal.svelte"

	initAuth()

	// Demo entry is synchronous so that no real fetch (boot, recovery) can start before the
	// lazy demo chunk loads; a stored key may coexist with the demo.
	ui.demoActive = new URLSearchParams(window.location.search).has("demo")

	let settingsOpen = $state(false)
	let memoryOpen = $state(false)
	let composerRef = $state<ChatPane | null>(null)

	/** Colors of the toast kinds in the inline toast stack. */
	const toastColors: Record<ToastKind, string> = {
		info: "border-line text-ink",
		success: "border-fresh/50 text-ink",
		error: "border-danger/60 text-ink",
	}

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
	let promptValue = $state("")
	let promptInputEl = $state<HTMLInputElement | null>(null)

	// The prompt form remounts with the config; focus its input when it appears.
	$effect(() => {
		if (promptConfig) promptInputEl?.focus()
	})

	/**
	 * Submits the inline prompt dialog: trims the value, closes the dialog, then runs the configured action.
	 */
	async function submitPrompt(e: SubmitEvent) {
		e.preventDefault()
		const trimmed = promptValue.trim()
		if (!trimmed || !promptConfig) return
		const run = promptConfig.submit
		promptConfig = null
		promptValue = ""
		await run(trimmed)
	}

	let booted = false

	$effect(() => {
		// auth.invalid is read so re-saving a rejected key re-triggers the boot. The demo
		// serves fake data through the same paths, so the boot fetch never runs in it.
		void auth.invalid
		if (auth.key && !booted && ui.liveData) {
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
					pushToast(`Couldn't load — ${errorMessage(err)}`, "error")
				})
		}
	})

	// One lazy import boots the demo whenever demo mode is on and not ready yet; a load
	// failure falls back to the normal app/auth screen.
	$effect(() => {
		if (!ui.demoActive || ui.demoReady || ui.demoLoading) return
		ui.demoLoading = true
		import("./lib/demo/state.svelte")
			.then((m) => m.startDemo())
			.catch(() => {
				ui.demoActive = false
				pushToast("Demo couldn't load — try again", "error")
			})
			.finally(() => (ui.demoLoading = false))
	})

	// Keep ?category=&topic= in sync with the selection; the demo keeps ?demo=1 untouched.
	$effect(() => {
		if (ui.demoActive) return
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

	const showAuth = $derived(ui.showAuth)

	function renameEntity(
		title: string,
		initial: string,
		run: (name: string) => Promise<void>,
	) {
		promptValue = initial
		promptConfig = { title, initial, submit: run }
	}

	function onRenameCategory(cat: CategorySummary) {
		renameEntity("Rename diary", cat.name, async (name) => {
			try {
				await api("POST", "/rename-category", { id: cat.id, name })
				await app.loadCategories()
				pushToast("Diary renamed", "success")
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
			title: "Delete diary",
			body: `Delete "${cat.name}" with all its topics and conversations? This cannot be undone.`,
			confirm: async () => {
				try {
					await api("DELETE", `/category?id=${cat.id}`)
					await app.loadCategories()
					await app.loadStream()
					pushToast("Diary deleted", "success")
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
		else pushToast(`${action} failed — ${errorMessage(err)}`, "error")
	}
</script>

{#if showAuth}
	<AuthOverlay />
{:else}
	<div class="flex h-dvh flex-col overflow-hidden">
		<header class="border-b border-line bg-panel/60 pt-2">
			<div class="flex items-center gap-1">
				<h1 class="shrink-0 pl-4 pr-1 font-serif text-sm font-semibold tracking-tight">pawmc</h1>
				<div class="min-w-0 flex-1">
					<CategoryTabs
						onrenamecategory={onRenameCategory}
						ondeletecategory={onDeleteCategory}
					/>
				</div>
			<div class="flex shrink-0 items-center gap-0.5 pr-2">
				<button
					class="icon-btn md:hidden"
					class:demo-spotlight={ui.spotlightMemory}
					title="Memory"
					aria-label="Memory"
					onclick={() => (memoryOpen = true)}
				>
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
				</button>
				<button
					class="icon-btn hidden md:inline-flex"
					title="Memory"
					aria-label="Memory"
					aria-pressed={!app.memoryHidden}
					onclick={() => (app.memoryHidden = !app.memoryHidden)}
				>
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
				</button>
			{#if ui.showSettings}
				<button class="icon-btn" title="Settings" aria-label="Settings" onclick={() => (settingsOpen = true)}>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
					</button>
			{/if}
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
		<div class="relative flex w-full flex-col bg-bg shadow-2xl">
			<MemoryBar onclose={() => (memoryOpen = false)} />
		</div>
	</div>
{/if}

{#if ui.demoActive && !ui.demoReady}
	<!-- Entry splash while the lazy demo chunk loads; the demo root replaces it. -->
	<div class="fixed inset-0 z-[80] flex items-center justify-center bg-bg">
		<p class="text-xs text-faint">Loading demo…</p>
	</div>
{/if}

<SettingsModal open={settingsOpen} onclose={() => (settingsOpen = false)} />

{#if promptConfig}
	<Modal open title={promptConfig.title} onclose={() => (promptConfig = null)}>
		<form class="flex flex-col gap-3" onsubmit={submitPrompt}>
			<input
				bind:this={promptInputEl}
				bind:value={promptValue}
				class="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
			/>
			<div class="flex justify-end gap-2">
				<button
					type="button"
					class="h-9 rounded-lg border border-line px-3.5 text-sm text-dim hover:bg-panel-2 hover:text-ink"
					onclick={() => (promptConfig = null)}>Cancel</button
				>
				<button
					type="submit"
					class="h-9 rounded-lg bg-accent px-3.5 text-sm font-medium text-white hover:bg-accent/85 disabled:opacity-40"
					disabled={!promptValue.trim()}>{promptConfig.submitLabel ?? "Save"}</button
				>
			</div>
		</form>
	</Modal>
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

{#if toasts.list.length}
	<div class="pointer-events-none fixed inset-x-0 bottom-16 z-[60] flex flex-col items-center gap-2 px-4">
		{#each toasts.list as toast (toast.id)}
			<button
				class="pointer-events-auto max-w-md rounded-lg border bg-panel px-4 py-2 text-xs shadow-xl {toastColors[toast.kind]}"
				onclick={() => dismissToast(toast.id)}
			>
				{toast.msg}
			</button>
		{/each}
	</div>
{/if}