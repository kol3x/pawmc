import { bindAuth } from "../api"

const STORAGE_KEY = "pa_api_key"

/** Auth state for the Bearer API key, persisted in localStorage under the same key as the legacy UI. */
class AuthState {
	key = $state("")
	/** Set when a request was rejected with 401 while a key was configured. */
	invalid = $state(false)
}

export const auth = new AuthState()

/**
 * Restores the stored API key and wires it into the api() helper. Call once at startup.
 */
export function initAuth(): void {
	auth.key = localStorage.getItem(STORAGE_KEY) ?? ""
	bindAuth(
		() => auth.key,
		() => {
			if (auth.key) auth.invalid = true
		},
	)
}
/**
 * Stores a new API key and clears the invalid flag.
 */
export function saveKey(key: string): void {
	auth.key = key.trim()
	auth.invalid = false
	if (auth.key) localStorage.setItem(STORAGE_KEY, auth.key)
	else localStorage.removeItem(STORAGE_KEY)
}
