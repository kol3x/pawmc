/** Client and request/response shapes of the pawmc worker API. */

export interface ChatMessage {
	role: string
	content: string
}

export interface TopicSummary {
	id: number
	name: string
	summary: string
	/** One-sentence distilled description used for at-a-glance recognition (v2 backend). */
	micro_summary?: string
	updated_at_timestamp: number
}

export interface CategorySummary extends TopicSummary {
	topics: TopicSummary[]
}

export interface ConversationListEntry {
	id: number
	category: string
	topic: string
	created_at: number
	last_message: string
}

export interface ConversationDetail {
	id: number
	category: string
	topic: string
	messages: ChatMessage[]
}

/** One conversation in a GET /topic-stream response. */
export interface TopicStreamEntry {
	id: number
	created_at: number
	messages: ChatMessage[]
}

/** v2 /chat response: topic/topicId are present when the backend supports topic autogen. */
export interface ChatResponse {
	response: string
	conversationId: number
	topic?: string
	topicId?: number
}

/** One ranked topic proposal from the autotopic gate; `exists` marks topics already in the category. */
export interface TopicCandidate {
	name: string
	summary: string
	confidence: number
	exists: boolean
	description?: string
}

/** 422 /chat response when the autotopic confidence gate is too low: nothing was stored. */
export interface TopicNeededResponse {
	topicNeeded: true
	candidates: TopicCandidate[]
}

export type SummaryType = "category" | "topic"

/** Payload of POST /update-summary. Empty summary means forget. */
export interface UpdateSummaryRequest {
	type: SummaryType
	id: number
	summary: string
}

/** Body shape of all worker error responses. */
export interface ApiErrorBody {
	error: string
}

/** Serves api() calls from the demo's fake backend; returns the response payload the caller expects. */
export type DemoRouter = (method: string, path: string, body?: unknown) => Promise<unknown>

let demoRouter: DemoRouter | null = null

/**
 * Toggles the demo's fake-API binding: passing a router binds it, null unbinds. While bound, api()
 * resolves every request through it instead of fetch, so the whole UI runs on demo data
 * with no backend calls. Kept as a binding, like bindAuth, to avoid a circular import.
 */
export function toggleDemoRouterBind(router: DemoRouter | null): void {
	demoRouter = router
}

/** Error thrown by api() for non-2xx responses, carrying the HTTP status and the parsed body (e.g. the 422 topic-needed payload). */
export class ApiError extends Error {
	status: number
	body: unknown

	constructor(status: number, message: string, body: unknown = null) {
		super(message)
		this.status = status
		this.body = body
	}
}

/**
 * Performs a JSON request against the worker API with Bearer auth, returning the parsed body. Throws ApiError with the server-provided {error} message on failure. When the demo router binding is active, the request is answered by it instead of the network.
 */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	if (demoRouter) return demoRouter(method, path, body) as T

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
		throw new ApiError(res.status, message, data)
	}
	return data as T
}

/**
 * Returns the current Bearer header value, empty when no API key is set.
 */
function authHeader(): string {
	// Read lazily via the bound accessor to avoid a circular import at module-eval time.
	const key = authKey()
	return key ? `Bearer ${key}` : ""
}

/**
 * Formats a thrown value for user-facing messages: the message for Error instances, the stringified value otherwise.
 */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

let authKey: () => string = () => ""
let markUnauthorized: () => void = () => {}

/**
 * Registers the auth state accessors so api() can attach the Bearer header and flag 401s without a circular import.
 */
export function bindAuth(keyGetter: () => string, onUnauthorized: () => void) {
	authKey = keyGetter
	markUnauthorized = onUnauthorized
}