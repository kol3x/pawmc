/** Request/response shapes of the pawmc worker API. */

export interface ChatMessage {
	role: string
	content: string
}

export interface TopicSummary {
	id: number
	name: string
	summary: string
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

/** v2 /chat response: topic/topicId are present when the backend supports topic autogen. */
export interface ChatResponse {
	response: string
	conversationId: number
	topic?: string
	topicId?: number
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
