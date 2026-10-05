import { auth } from "./appState.svelte"

/**
 * Centralized UI capability surface for demo mode. Every demo-sensitive affordance is
 * derived here once — components read `ui.canMutate` / `ui.showAuth` etc. instead of
 * re-checking the demo flag, so a new mutating control only has to gate on the one
 * capability it needs and stays correct as the demo grows new steps.
 */
class UiState {
	/** Demo simulation mode: fake data, no backend, no persistence. Set synchronously at entry (URL param or auth-screen button); cleared only by the exit reload. */
	demoActive = $state(false)
	/** True while the lazy demo chunk is loading (entry splash shows). */
	demoLoading = $state(false)
	/** True once the demo module mounted its root overlay. */
	demoReady = $state(false)
	/** True once the demo asks for attention on the memory panel (day 2 — where the summaries live). Set by the demo state; stays for the rest of the run, the pulse animation is finite. */
	spotlightMemory = $state(false)

	/** Mutating affordances — creating/renaming/deleting diaries, topics, conversations and messages, and memory revise/forget/refresh. The demo shows none of them. */
	canMutate = $derived(!this.demoActive)
	/** Auth gate: no key stored, or the stored key was rejected. Never shown while the demo runs. */
	showAuth = $derived(!this.demoActive && (auth.key === "" || auth.invalid))
	/** Settings button: key and model management is meaningless inside the demo. */
	showSettings = $derived(!this.demoActive)
	/** Talking to the real backend for data loads (boot fetch, recovery probes). The demo serves fake data through the same paths instead. */
	liveData = $derived(!this.demoActive)
}

export const ui = new UiState()
