import type {
	CategorySummary,
	ChatMessage,
	ChatResponse,
	ConversationDetail,
	ConversationListEntry,
} from "../api-types"
import { api } from "../api"
import { pushToast } from "./toasts.svelte"

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

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/** Global UI state: category/topic selection, continuous conversation stream, send + recovery. */
class AppState {
	categories = $state<CategorySummary[] | null>(null)
	categoryId = $state<number | null>(null)
	topicId = $state<number | null>(null)
	/** Optional topic name typed before sending (creates a topic on the fly). */
	draftTopicName = $state("")
	/** True while the composer targets a brand-new topic (from the New topic button or empty category). */
	newTopicMode = $state(false)
	view = $state<"chat" | "context">("chat")
	stream = $state<ConversationGroup[]>([])
	loadingStream = $state(false)
	sending = $state(false)
	pendingChat = $state<PendingChat | null>(null)
	lastCategoriesLoad = 0

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
	 * Keeps the current selection if it still exists, otherwise falls back to the first category/topic.
	 */
	retainSelection(): void {
		const cats = this.categories ?? []
		const cat = cats.find((c) => c.id === this.categoryId) ?? cats[0] ?? null
		this.categoryId = cat?.id ?? null
		const topic = cat?.topics.find((t) => t.id === this.topicId) ?? cat?.topics[0] ?? null
		this.topicId = topic?.id ?? null
	}

	/**
	 * Selects a category; auto-selects its first topic, leaving the composer in new-topic mode when it has none.
	 */
	selectCategory(categoryId: number): void {
		if (categoryId === this.categoryId) return
		this.categoryId = categoryId
		const cat = this.categories?.find((c) => c.id === categoryId)
		this.topicId = cat?.topics[0]?.id ?? null
		this.draftTopicName = ""
		this.newTopicMode = cat ? cat.topics.length === 0 : false
		this.view = "chat"
		void this.loadStream()
	}

	/**
	 * Selects a topic within a category and (re)loads its stream.
	 */
	selectTopic(categoryId: number, topicId: number): void {
		this.categoryId = categoryId
		this.topicId = topicId
		this.draftTopicName = ""
		this.newTopicMode = false
		this.view = "chat"
		void this.loadStream()
	}

	/**
	 * Enters new-topic mode: the composer gets an empty topic name field; sending creates the topic (or autogens one when left blank).
	 */
	startNewTopic(): void {
		this.newTopicMode = true
		this.draftTopicName = ""
		this.view = "chat"
	}

	/**
	 * Selects a topic by id (used after /chat returns topicId for autogen or a new topic).
	 */
	selectTopicById(topicId: number): void {
		for (const cat of this.categories ?? []) {
			if (cat.topics.some((t) => t.id === topicId)) {
				this.selectTopic(cat.id, topicId)
				this.newTopicMode = false
				return
			}
		}
	}

	/**
	 * Restores category/topic selection from URL query params (?category=&topic=), matching by name.
	 */
	restoreFromUrl(): void {
		const params = new URLSearchParams(window.location.search)
		const catName = params.get("category")
		const topicName = params.get("topic")
		if (!catName) return
		const cat = this.categories?.find((c) => c.name === catName)
		if (!cat) return
		this.categoryId = cat.id
		const topic = topicName
			? cat.topics.find((t) => t.name === topicName)
			: (cat.topics[0] ?? null)
		this.topicId = topic?.id ?? null
	}

	/**
	 * Loads the topic's conversations and merges them into a continuous ascending message stream.
	 */
	async loadStream(): Promise<void> {
		const cat = this.selectedCategory
		const topic = this.selectedTopic
		if (!cat || !topic) {
			this.stream = []
			return
		}
		this.loadingStream = true
		try {
			const query = `category=${encodeURIComponent(cat.name)}&topic=${encodeURIComponent(topic.name)}`
			const list = await api<ConversationListEntry[]>("GET", `/conversations?${query}`)
			const ascending = [...list].sort((a, b) => a.created_at - b.created_at)
			const details = await Promise.all(
				ascending.map((entry) =>
					api<ConversationDetail>("GET", `/conversation?id=${entry.id}`).catch(
						() => null,
					),
				),
			)
			this.stream = ascending
				.map((entry, i) => {
					const detail = details[i]
					return {
						id: entry.id,
						createdAt: entry.created_at,
						summarized:
							topic.updated_at_timestamp !== 0 &&
							entry.created_at < topic.updated_at_timestamp,
						messages: (detail?.messages ?? []).map((m, index) => ({
							...m,
							conversationId: entry.id,
							index,
							createdAt: entry.created_at,
						})),
					}
				})
				.filter((g) => g.messages.length > 0)
		} catch (err) {
			pushToast(`Couldn't load the conversation stream — ${errorMessage(err)}`, "error")
		} finally {
			this.loadingStream = false
		}
	}

	/**
	 * Sends a message: appends an optimistic user bubble, posts to /chat, then refreshes
	 * categories (topic may be created) and the stream. Returns true on success; on failure
	 * the optimistic bubble is removed and the caller should restore the draft.
	 */
	async sendMessage(text: string, noteMode: boolean, categoryName?: string): Promise<boolean> {
		const catName = categoryName || this.selectedCategory?.name
		if (!catName) {
			pushToast("Pick a category first", "error")
			return false
		}
		const topicName = this.newTopicMode
			? this.draftTopicName.trim()
			: (this.draftTopicName.trim() || this.selectedTopic?.name || "")

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
		const promise = api<ChatResponse>("POST", "/chat", payload)
		const pc: PendingChat = {
			promise,
			category: catName,
			topic: topicName,
			draft: text,
			noteMode,
			startedAt: nowSec,
			recovered: false,
		}
		this.pendingChat = pc
		try {
			const res = await promise
			await this.loadCategories()
			if (res.topicId != null && res.topicId !== this.topicId) this.selectTopicById(res.topicId)
			else if (this.newTopicMode && res.topicId == null) this.retainSelection()
			await this.loadStream()
			this.newTopicMode = false
			return true
		} catch (err) {
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
		for (let attempt = 0; attempt < 8; attempt++) {
			if (this.pendingChat !== pc) return
			const found = await this.probeReply(pc)
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
	 */
	async probeReply(pc: PendingChat): Promise<boolean> {
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

/**
 * Formats a thrown value for toasts: the message for Error instances, the stringified value otherwise.
 */
function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

export const app = new AppState()
