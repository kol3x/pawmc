import type { ApiErrorBody } from "./api-types"

/** Error thrown by api() for non-2xx responses, carrying the HTTP status. */
export class ApiError extends Error {
	status: number

	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

/**
 * Performs a JSON request against the worker API with Bearer auth, returning the parsed body. Throws ApiError with the server-provided {error} message on failure.
 */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = {}
	if (body !== undefined) headers["Content-Type"] = "application/json"
	if (authHeader()) headers["Authorization"] = authHeader()

	const res = await fetch(path, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	})

	let data: unknown = null
	try {
		data = await res.json()
	} catch {
		// Non-JSON error bodies keep the generic message below.
	}

	if (!res.ok) {
		if (res.status === 401) markUnauthorized()
		const message = (data as ApiErrorBody | null)?.error || `Request failed (${res.status})`
		throw new ApiError(res.status, message)
	}
	return data as T
}

/**
 * Returns the current Bearer header value, empty when no API key is set.
 */
function authHeader(): string {
	// Imported lazily to avoid a circular import at module-eval time.
	const key = authKey()
	return key ? `Bearer ${key}` : ""
}

let authKey: () => string = () => ""
let markUnauthorized: () => void = () => {}

/**
 * Registers the auth store accessors so api() can attach the Bearer header and flag 401s without a circular import.
 */
export function bindAuth(keyGetter: () => string, onUnauthorized: () => void) {
	authKey = keyGetter
	markUnauthorized = onUnauthorized
}
