const STORAGE_KEY = "pa_freshness"

/** UI preferences persisted in localStorage. */
class SettingsState {
	/** Sidebar filter: 0 = topics updated today only, 3 = everything. */
	freshnessFilter = $state(0)
	/** Whether the fullscreen composer is open. */
	fullscreenComposer = $state(false)
}

export const settings = new SettingsState()

/**
 * Restores persisted settings. Call once at startup.
 */
export function initSettings(): void {
	const stored = Number(localStorage.getItem(STORAGE_KEY) ?? 0)
	if (Number.isInteger(stored) && stored >= 0 && stored <= 3) settings.freshnessFilter = stored
}

/**
 * Persists the freshness filter level.
 */
export function setFreshnessFilter(level: number): void {
	settings.freshnessFilter = level
	localStorage.setItem(STORAGE_KEY, String(level))
}
