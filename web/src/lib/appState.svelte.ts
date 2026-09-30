import type {
	CategorySummary,
	ChatMessage,
	ChatResponse,
	ConversationDetail,
	ConversationListEntry,
	TopicCandidate,
	TopicNeededResponse,
	TopicStreamEntry,
} from "../api"
import { api, ApiError, bindAuth, errorMessage } from "../api"

const STORAGE_KEY = "pa_api_key"

export type ToastKind = "info" | "success" | "error"

export interface Toast {
	id: number
	msg: string
	kind: ToastKind
}

/** Global toast queue rendered inline by App. */
class ToastState {
	list = $state<Toast[]>([])
}

export const toasts = new ToastState()

let nextToastId = 1

/**
 * Queues a toast shown for ~3.5s.
 */
export function pushToast(msg: string, kind: ToastKind = "info"): void {
	const id = nextToastId++
	toasts.list = [...toasts.list, { id, msg, kind }]
	window.setTimeout(() => dismissToast(id), 3500)
}

/**
 * Removes a toast by id.
 */
export function dismissToast(id: number): void {
	toasts.list = toasts.list.filter((t) => t.id !== id)
}

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

/** A message in the merged continuous stream, tagged with its owning conversation. */
export interface StreamMessage extends ChatMessage {
	conversationId: number
	/** Position of the message inside its conversation (for update/delete endpoints). */
	index: number
	/** Conversation creation timestamp (unix seconds). */
	createdAt: number
	/** True until the server confirms the send. */
	pending?: boolean
}

/** One conversation's slice of the continuous stream. */
export interface ConversationGroup {
	id: number
	createdAt: number
	messages: StreamMessage[]
	/** True when the conversation predates the topic's summary watermark (already folded into memory). */
	summarized: boolean
}

interface PendingChat {
	promise: Promise<ChatResponse>
	category: string
	/** Requested topic name; empty string means autogen. */
	topic: string
	draft: string
	noteMode: boolean
	/** Send start time (unix seconds), used to recognize the reply conversation. */
	startedAt: number
	/** Set by recovery when the reply was found server-side despite a dead fetch. */
	recovered: boolean
}

/** A send interrupted by the autotopic confidence gate (422): nothing was stored; the draft waits for a topic choice. */
export interface TopicNeededState {
	/** Message text to resend once a topic is picked. */
	draft: string
	noteMode: boolean
	/** Category the send targeted. */
	categoryName: string
	candidates: TopicCandidate[]
}

/**
 * Narrows an ApiError body into the 422 topic-needed payload.
 */
function isTopicNeeded(body: unknown): body is TopicNeededResponse {
	if (typeof body !== "object" || body === null) return false
	const candidate = body as { topicNeeded?: unknown; candidates?: unknown }
	return candidate.topicNeeded === true && Array.isArray(candidate.candidates)
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/** Global UI state: category/topic selection, continuous conversation stream, send + recovery. */
class AppState {
	categories = $state<CategorySummary[] | null>(null)
	categoryId = $state<number | null>(null)
	topicId = $state<number | null>(null)
	/** Staged name for a not-yet-created category (ghost tab); it becomes real on the first send. */
	pendingCategoryName = $state("")
	/** Set when a send was interrupted by the autotopic gate; the composer area shows a candidate picker. */
	topicNeeded = $state<TopicNeededState | null>(null)
	stream = $state<ConversationGroup[]>([])
	loadingStream = $state(false)
	sending = $state(false)
	pendingChat = $state<PendingChat | null>(null)
	/** In-flight post-send categories/stream refresh; next sends serialize behind it. */
	refreshPromise: Promise<void> | null = null
	lastCategoriesLoad = 0
	/** Bumped on every user-driven selection change; background refreshes abort when it moves so they cannot override navigation. */
	selectionEpoch = 0

	selectedCategory = $derived.by(
		() => this.categories?.find((c) => c.id === this.categoryId) ?? null,
	)
	selectedTopic = $derived.by(
		() => this.selectedCategory?.topics.find((t) => t.id === this.topicId) ?? null,
	)

	/**
	 * Fetches categories and keeps (or restores) a valid selection.
	 */
	async loadCategories(): Promise<void> {
		const cats = await api<CategorySummary[]>("GET", "/categories")
		this.categories = cats
		this.lastCategoriesLoad = Date.now()
		this.retainSelection()
	}

	/**
	 * Keeps the current selection only when it still exists; otherwise clears it so the UI falls back to the empty new-conversation state instead of jumping to an arbitrary topic.
	 */
	retainSelection(): void {
		const cats = this.categories ?? []
		this.categoryId = cats.find((c) => c.id === this.categoryId)?.id ?? null
		const topic = this.selectedCategory?.topics.find((t) => t.id === this.topicId)
		this.topicId = topic?.id ?? null
	}

	/**
	 * Selects a category and shows the empty new-conversation composer; topics open through explicit selection only. Cancels a staged ghost category.
	 */
	selectCategory(categoryId: number): void {
		if (categoryId === this.categoryId) return
		this.selectionEpoch++
		this.categoryId = categoryId
		this.topicId = null
		this.pendingCategoryName = ""
		this.stream = []
	}

	/**
	 * Selects a topic within a category and (re)loads its stream.
	 */
	selectTopic(categoryId: number, topicId: number): void {
		this.selectionEpoch++
		this.categoryId = categoryId
		this.topicId = topicId
		this.pendingCategoryName = ""
		this.stream = []
		void this.loadStream()
	}

	/**
	 * Clears the topic selection so the next send autogens a fresh topic; the category stays selected.
	 */
	deselectTopic(): void {
		this.selectionEpoch++
		this.topicId = null
		this.stream = []
	}

	/**
	 * Stages a ghost category tab: the name is not saved server-side until the first message is sent.
	 */
	stageNewCategory(name: string): void {
		this.selectionEpoch++
		this.pendingCategoryName = name.trim()
		this.categoryId = null
		this.topicId = null
		this.stream = []
	}

	/**
	 * Discards the staged ghost category.
	 */
	cancelPendingCategory(): void {
		this.pendingCategoryName = ""
	}

	/**
	 * Selects a topic by id (used after /chat returns topicId for autogen or a new topic).
	 */
	selectTopicById(topicId: number): void {
		for (const cat of this.categories ?? []) {
			if (cat.topics.some((t) => t.id === topicId)) {
				this.selectTopic(cat.id, topicId)
				return
			}
		}
	}

	/**
	 * Restores category/topic selection from URL query params (?category=&topic=), matching by name; the topic stays empty when the URL names only a category.
	 */
	restoreFromUrl(): void {
		const params = new URLSearchParams(window.location.search)
		const catName = params.get("category")
		const topicName = params.get("topic")
	if (!catName) return
	const cat = this.categories?.find((c) => c.name === catName)
	if (!cat) return
	this.selectionEpoch++
	this.categoryId = cat.id
		this.topicId = topicName ? (cat.topics.find((t) => t.name === topicName)?.id ?? null) : null
	}

	/**
	 * Loads the topic's conversations in one /topic-stream request and merges them into a continuous ascending message stream.
	 */
	async loadStream(): Promise<void> {
		const epoch = this.selectionEpoch
		const cat = this.selectedCategory
		const topic = this.selectedTopic
		if (!cat || !topic) {
			this.stream = []
			return
		}
		this.loadingStream = true
		try {
			const query = `category=${encodeURIComponent(cat.name)}&topic=${encodeURIComponent(topic.name)}`
			const entries = await api<TopicStreamEntry[]>("GET", `/topic-stream?${query}`)
			if (this.selectionEpoch !== epoch) return
			this.stream = entries
				.map((entry) => ({
					id: entry.id,
					createdAt: entry.created_at,
					summarized:
						topic.updated_at_timestamp !== 0 &&
						entry.created_at < topic.updated_at_timestamp,
					messages: entry.messages.map((m: ChatMessage, index: number) => ({
						...m,
						conversationId: entry.id,
						index,
						createdAt: entry.created_at,
					})),
				}))
				.filter((g) => g.messages.length > 0)
		} catch (err) {
			pushToast(`Couldn't load the conversation stream — ${errorMessage(err)}`, "error")
		} finally {
			this.loadingStream = false
		}
	}

	/**
	 * Sends a message: appends an optimistic user bubble, posts to /chat, renders the
	 * assistant reply immediately from the response, then refreshes categories and the
	 * stream in the background. The category resolves to an explicit override, else the
	 * staged ghost tab name, else the selected tab; the topic resolves to an explicit
	 * override (autotopic picker), else the selected topic, else autogen. On a 422
	 * autotopic gate response nothing is stored and the draft waits in a candidate picker
	 * (topicNeeded). Returns true when the send was accepted (or parked for topic
	 * picking); on failure the optimistic bubble is removed and the caller should restore
	 * the draft.
	 *
	 * Arrow field on purpose: Svelte 5 compiles bare method references passed as props
	 * (onsend={app.sendMessage}) into calls on the props object, so a regular method
	 * would lose `this` and see an empty state.
	 */
	sendMessage = async (text: string, noteMode: boolean, categoryName?: string, topicOverride?: string): Promise<boolean> => {
		if (this.refreshPromise) await this.refreshPromise
		this.topicNeeded = null

		const catName = categoryName || this.pendingCategoryName || this.selectedCategory?.name
		if (!catName) {
			pushToast("Pick a category first", "error")
			return false
		}
		const topicName = topicOverride?.trim() || this.selectedTopic?.name || ""

		const payload: Record<string, unknown> = { category: catName, message: text, noteMode }
		if (topicName) payload.topic = topicName

		const nowSec = Math.floor(Date.now() / 1000)
		const lastGroup = this.stream.at(-1)
		let group: ConversationGroup
		if (lastGroup && !lastGroup.summarized) {
			group = lastGroup
		} else {
			this.stream = [...this.stream, { id: -1, createdAt: nowSec, summarized: false, messages: [] }]
			group = this.stream.at(-1) as ConversationGroup
		}
		group.messages = [
			...group.messages,
			{ role: "user", content: text, conversationId: -1, index: group.messages.length, createdAt: nowSec, pending: true },
		]

		this.sending = true
		const sentEpoch = this.selectionEpoch
		const promise = api<ChatResponse>("POST", "/chat", payload)
		let pc: PendingChat = {
			promise,
			category: catName,
			topic: topicName,
			draft: text,
			noteMode,
			startedAt: nowSec,
			recovered: false,
		}
		this.pendingChat = pc
		// Reading the field back yields the reactive proxy instance; identity checks
		// and the recovered flag must run against that same instance, not the raw object.
		pc = this.pendingChat as PendingChat
		try {
			const res = await promise

			// Render the reply immediately from the response; server truth follows in the background.
			group.id = res.conversationId
			group.messages = [
				...group.messages.map((m) =>
					m.pending ? { ...m, pending: false, conversationId: res.conversationId } : m,
				),
				{
					role: "assistant",
					content: res.response,
					conversationId: res.conversationId,
					index: group.messages.length,
					createdAt: group.createdAt,
				},
			]

			const refresh = this.refreshAfterChat(res, pc.category, sentEpoch)
			this.refreshPromise = refresh
			void refresh.finally(() => {
				if (this.refreshPromise === refresh) this.refreshPromise = null
			})
			return true
		} catch (err) {
			if (err instanceof ApiError && err.status === 422 && isTopicNeeded(err.body)) {
				group.messages = group.messages.filter((m) => !m.pending)
				if (group.id === -1 && group.messages.length === 0)
					this.stream = this.stream.filter((g) => g !== group)
				this.topicNeeded = { draft: text, noteMode, categoryName: catName, candidates: err.body.candidates }
				return true
			}
			group.messages = group.messages.filter((m) => !m.pending)
			if (group.id === -1 && group.messages.length === 0)
				this.stream = this.stream.filter((g) => g !== group)
			if (!pc.recovered) pushToast(`Send failed — ${errorMessage(err)}`, "error")
			return pc.recovered
		} finally {
			this.sending = false
			if (this.pendingChat === pc) this.pendingChat = null
		}
	}

	/**
	 * Post-send refresh: categories (the topic or ghost category may be new), then selection
	 * + stream reconciliation — the reply's topic is followed when it differs, a staged ghost
	 * category is selected once it exists, and otherwise the current topic's stream reloads.
	 * sentEpoch is the selection epoch captured when the send started; when the user navigated
	 * while the request was in flight, the refresh only updates data and never moves selection.
	 */
	async refreshAfterChat(res: ChatResponse, sentCategory: string, sentEpoch: number): Promise<void> {
		try {
			await this.loadCategories()
			if (this.selectionEpoch !== sentEpoch) return
			if (res.topicId != null && res.topicId !== this.topicId) {
				this.selectTopicById(res.topicId)
			} else if (this.pendingCategoryName && this.pendingCategoryName === sentCategory) {
				const cat = this.categories?.find((c) => c.name === sentCategory)
				if (cat && cat.id !== this.categoryId) this.selectCategory(cat.id)
				else await this.loadStream()
			} else {
				await this.loadStream()
			}
			if (this.pendingCategoryName === sentCategory) this.pendingCategoryName = ""
		} catch (err) {
			pushToast(`Couldn't refresh — ${errorMessage(err)}`, "error")
		}
	}

	/**
	 * Resends a message parked by the autotopic gate under the picked topic name, targeting the parked category.
	 */
	async pickTopicAndResend(topicName: string): Promise<void> {
		const parked = this.topicNeeded
		if (!parked) return
		this.topicNeeded = null
		const cat = this.categories?.find((c) => c.name === parked.categoryName)
		if (cat && cat.id !== this.categoryId) {
			this.selectionEpoch++
			this.categoryId = cat.id
			this.topicId = null
			this.stream = []
		}
		await this.sendMessage(parked.draft, parked.noteMode, parked.categoryName, topicName)
	}

	/**
	 * Discards a parked autotopic pick, handing the draft back to the caller (e.g. the composer).
	 */
	cancelTopicNeeded(): string | null {
		const parked = this.topicNeeded
		this.topicNeeded = null
		return parked?.draft ?? null
	}

	/**
	 * Called when the tab becomes visible/focused again. Reconciles a chat request whose
	 * fetch may have been killed (e.g. iOS backgrounding) by polling the server for the
	 * persisted reply; otherwise silently refreshes stale categories.
	 */
	async recover(): Promise<void> {
		const pc = this.pendingChat
		if (!pc) {
			if (Date.now() - this.lastCategoriesLoad > 60_000) {
				try {
					await this.loadCategories()
				} catch {
					// Offline in the background; the next interaction retries.
				}
			}
			return
		}
		if (pc.recovered) return
		const epoch = this.selectionEpoch
		for (let attempt = 0; attempt < 8; attempt++) {
			if (this.pendingChat !== pc) return
			const found = await this.probeReply(pc, epoch)
			if (found) {
				pc.recovered = true
				this.pendingChat = null
				this.sending = false
				pushToast("Recovered your reply", "success")
				return
			}
			await sleep(2000)
		}
	}

	/**
	 * Checks whether the reply for a pending chat already exists on the server; if so, refreshes selection + stream and returns true.
	 * The reply may land in an existing fresh conversation (topic continuation), so the newest few conversations are probed by content.
	 * When the user navigated since recovery started (epoch moved), the reply is acknowledged without touching their selection.
	 */
	async probeReply(pc: PendingChat, epoch: number): Promise<boolean> {
		try {
			let query = `category=${encodeURIComponent(pc.category)}`
			if (pc.topic) query += `&topic=${encodeURIComponent(pc.topic)}`
			const list = await api<ConversationListEntry[]>("GET", `/conversations?${query}`)
			const candidates = list
				.filter((c) => c.created_at >= pc.startedAt - 60)
				.slice(0, 3)
			for (const entry of candidates) {
				const detail = await api<ConversationDetail>("GET", `/conversation?id=${entry.id}`)
				const messages = detail.messages
				const lastUserIdx = messages.findLastIndex((m) => m.role === "user")
				const ours = messages[lastUserIdx]?.content?.trim() === pc.draft.trim()
				const answered = messages.at(-1)?.role === "assistant"
				if (!ours || !answered) continue
				if (this.selectionEpoch !== epoch) return true
				await this.loadCategories()
				if (!pc.topic) {
					// Autogen may have picked any topic in the category; follow the reply.
					const cat = this.categories?.find((c) => c.id === this.categoryId)
					const matched = cat?.topics.find((t) => t.name === entry.topic)
					if (cat && matched) this.selectTopic(cat.id, matched.id)
				}
				await this.loadStream()
				return true
			}
			return false
		} catch {
			return false
		}
	}
}

export const app = new AppState()
