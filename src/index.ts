import { DurableObject } from "cloudflare:workers"
import { AiConversationEntry, TOPIC_CONFIDENCE_MIN, distillMicroSummary, firstSentence, resolveTopic, runAI, systemInstruction, type TopicCandidate } from "./ai"
import { errorMessage } from "./errors"
import { handleRequest } from "./routes"

/**
 * Cloudflare Worker that uses SQLite-backed Durable Object. Works as a personal LLM assistant. It stores conversations and uses summed up context when generating responses.
 *
 * Features:
 * - Stores conversations by predifined category and topic (e.g., "work": "project X context", "personal": "choosing a country to travel", "languages": "Ukrainian").
 * - Stores a summary-context for each category and topic. Adjusts these daily by processing new conversations.
 * - When new conversation is started and category or topic is non predifined, it will be created and added to the list of categories.
 * - Endpoint to fetch all categories and topics, and their summaries.
 * - Categories and topics can be renamed or deleted, and individual messages can be edited or deleted while their conversation is not yet summarized.
 * - When a chat starts without a topic, a light labeling model proposes ranked topics with confidence; high-confidence picks proceed automatically, low confidence returns candidates for one-click user choice.
 * - Each topic carries a one-sentence micro summary, distilled on the nightly fold and used for topic picking and UI display.
 *
 * ## Best Practices
 * - Simplicity, reliability, and efficiency.
 * - Stick to JSDoc for specifications and documentation, but not type definitions.
 * - Robust error handling and logging techniques with succinct messages. Wrapping each data processing stage in a try-catch block, validating all inputs and outputs, and using `INFO` and `ERROR` levels with detailed contextual information, such as processing stage, task name, etc.
 * - Concise code with minimal formatting and indentation, which prioritizes descriptive element naming and log messages over inline comments to achieve readability.
 */

export interface TopicRow {
  id: number
  name: string
  summary: string
  updated_at_timestamp: number
}

/**
 * A topic row as exposed through /categories, adding the one-sentence micro summary used for topic picking and UI display.
 */
export interface TopicDetailRow extends TopicRow {
  micro_summary: string
}

export interface CategoryRow extends TopicRow {
  topics: TopicDetailRow[]
}

export interface ChatResult {
  response: string
  conversationId: number
  topic: string
  topicId: number
}

/**
 * Outcome of a DO mutation: "ok" on success, "not_found" when the target row or message index is missing, "name_taken" on rename collisions, "summarized" when the conversation has already been folded into its summary.
 */
export type MutationResult = { status: "ok" | "not_found" | "name_taken" | "summarized" }

export interface ConversationDetail {
  id: number
  category: string
  topic: string
  messages: AiConversationEntry[]
}

export interface ConversationListEntry {
  id: number
  category: string
  topic: string
  created_at: number
  last_message: string
}

/**
 * One conversation in a topic's full stream: the same shape as ConversationDetail plus the creation timestamp the frontend uses to order the stream and detect summarized conversations.
 */
export interface TopicStreamEntry {
  id: number
  created_at: number
  messages: AiConversationEntry[]
}

/**
 * Returned by chat() when topic autogen confidence is too low: nothing was stored and the caller should offer the candidates as one-click choices.
 */
export interface TopicNeededResult {
  topicNeeded: true
  candidates: TopicCandidate[]
}

export interface Env extends Cloudflare.Env {
  ASSISTANT_DO: DurableObjectNamespace<AssistantDurableObject>
  API_KEY: string
  OPENROUTER_API_KEY?: string
  /**
   * Optional overrides for the defaults baked into src/ai.ts; unset on a fresh deploy.
   */
  AI_PROVIDER?: string
  AI_MODEL_WORKERS_AI?: string
  AI_MODEL_OPENROUTER?: string
  AI_MODEL_OPENROUTER_LIGHT?: string
  AI_SYSTEM_INSTRUCTION?: string
}

export class AssistantDurableObject extends DurableObject<Env> {
  #db

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.#db = state.storage.sql
    this.initSchema()
  }

  /**
   * Creates the SQLite schema and backfills columns missing from older databases.
   */
  async initSchema() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        summary TEXT NOT NULL DEFAULT '',
        updated_at_timestamp INTEGER DEFAULT (strftime('%s', 'now'))
      );

      CREATE TABLE IF NOT EXISTS topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        micro_summary TEXT NOT NULL DEFAULT '',
        updated_at_timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(category_id, name),
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER NOT NULL,
        messages TEXT NOT NULL DEFAULT '[]',
        last_message TEXT NOT NULL DEFAULT '',
        created_at_timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
      );
    `)

    const categoryColumns = this.#db.exec(`PRAGMA table_info(categories)`).toArray()
    const hasUpdatedAtTimestamp = categoryColumns.some((col) => col.name === "updated_at_timestamp")
    if (!hasUpdatedAtTimestamp) {
      this.#db.exec(`ALTER TABLE categories ADD COLUMN updated_at_timestamp INTEGER DEFAULT (strftime('%s', 'now'))`)
    }

    const topicColumns = this.#db.exec(`PRAGMA table_info(topics)`).toArray()
    const hasUpdatedAtTimestampTopics = topicColumns.some((col) => col.name === "updated_at_timestamp")
    if (!hasUpdatedAtTimestampTopics) {
      this.#db.exec(`ALTER TABLE topics ADD COLUMN updated_at_timestamp INTEGER DEFAULT (strftime('%s', 'now'))`)
    }

    if (!topicColumns.some((col) => col.name === "micro_summary")) {
      this.#db.exec(`ALTER TABLE topics ADD COLUMN micro_summary TEXT NOT NULL DEFAULT ''`)
    }

    const convColumns = this.#db.exec(`PRAGMA table_info(conversations)`).toArray()
    if (!convColumns.some((col) => col.name === "last_message")) {
      this.#db.exec(`ALTER TABLE conversations ADD COLUMN last_message TEXT NOT NULL DEFAULT ''`)
    }
  }

  /**
   * Parses the messages from conversations, handling any JSON parsing errors gracefully.
   */
  #parseMessages(conversations: Array<Record<string, SqlStorageValue>>): AiConversationEntry[] {
    return conversations.flatMap((conv) => {
      try {
        return AiConversationEntry.array().parse(JSON.parse(String(conv.messages)))
      } catch (err) {
        console.error(`[ERROR] Failed to parse messages for conversation=${conv.id}: ${errorMessage(err)}`)
        return []
      }
    })
  }

  /**
   * Loads a conversation for editing and applies the unsummarized rule: a conversation stays mutable while its creation timestamp is at or after the topic's last summary update — the same freshness rule chat() uses to reuse conversations.
   */
  #loadMutableConversation(id: number): { messages: AiConversationEntry[] } | "not_found" | "summarized" {
    const [row] = this.#db
      .exec(
        `SELECT c.messages, c.created_at_timestamp, t.updated_at_timestamp AS topic_updated_at
         FROM conversations c
         JOIN topics t ON t.id = c.topic_id
         WHERE c.id = ?`,
        id,
      )
      .toArray()
    if (!row) return "not_found"
    if (Number(row.created_at_timestamp || 0) < Number(row.topic_updated_at || 0)) return "summarized"

    try {
      return { messages: AiConversationEntry.array().parse(JSON.parse(String(row.messages || "[]"))) }
    } catch (err) {
      console.error(`[ERROR] Failed to parse messages for conversation=${id}: ${errorMessage(err)}`)
      throw new Error(`Failed to parse messages for conversation=${id}`)
    }
  }

  /**
   * Processes a user message within a specified category and topic, generates an AI response using the stored conversation history and summary context, and updates the conversation. If the category or topic doesn't exist, it will be created.
   *
   * Reuses the topic's latest conversation only if it was created at or after the topic's last
   * summary update (i.e. it hasn't been folded into the summary yet). Otherwise, since the
   * existing conversation is considered already summarized, a new conversation is started.
   *
   * When the topic is empty, the light labeling model ranks topic candidates with confidence: at TOPIC_CONFIDENCE_MIN or above the top candidate proceeds like an explicit topic (new labels also carry a one-sentence micro summary), below it a TopicNeededResult is returned with nothing stored so the caller can offer one-click choices.
   */
  async chat(category: string, topic: string, userMessage: string, noteMode: boolean = false): Promise<ChatResult | TopicNeededResult> {
    const stage = "chat"
    try {
      if (!category?.trim() || !userMessage?.trim())
        throw new Error(`[${stage}] Invalid input: category and userMessage are required`)

      const categoryRow = this.#db
        .exec(
          `INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id, summary`,
          category.trim(),
        )
        .one()
      console.log(`[INFO][${stage}] Category resolved: id=${categoryRow.id}, name=${category}`)

      const providedTopic = topic?.trim() || ""
      let topicName = providedTopic
      let newTopicMicro: string | undefined

      if (!topicName) {
        const resolved = await resolveTopic(this.env, this.#db, Number(categoryRow.id), userMessage.trim())
        if (resolved.topic) {
          topicName = resolved.topic
        } else {
          const top = resolved.candidates[0]
          if (!top || top.confidence < TOPIC_CONFIDENCE_MIN) {
            console.log(`[INFO][${stage}] Topic confidence too low, asking user: candidates=${resolved.candidates.length}`)
            return { topicNeeded: true, candidates: resolved.candidates }
          }
          topicName = top.name
          newTopicMicro = top.description
        }
      }

      const topicRow = this.#db
        .exec(
          `INSERT INTO topics (category_id, name, micro_summary) VALUES (?, ?, ?) ON CONFLICT(category_id, name) DO UPDATE SET name=name RETURNING id, summary, updated_at_timestamp`,
          categoryRow.id,
          topicName,
          newTopicMicro || "",
        )
        .one()
      console.log(`[INFO][${stage}] Topic resolved: id=${topicRow.id}, name=${topicName}`)

      const [existingConversation] = this.#db
        .exec(
          `SELECT id, messages, created_at_timestamp FROM conversations WHERE topic_id = ? ORDER BY created_at_timestamp DESC LIMIT 1`,
          topicRow.id,
        )
        .toArray()

      const isConversationFresh =
        existingConversation &&
        existingConversation.created_at_timestamp &&
        (!topicRow.updated_at_timestamp ||
          Number(existingConversation.created_at_timestamp || 0) >= Number(topicRow.updated_at_timestamp || 0))

      let conversationId
      let messages: AiConversationEntry[] = []

      if (isConversationFresh) {
        conversationId = existingConversation.id
        try {
          messages = JSON.parse(String(existingConversation.messages))
        } catch (err) {
          console.error(`[ERROR][${stage}] Failed to parse messages for conversation=${conversationId}: ${errorMessage(err)}`)
          messages = []
        }
      } else {
        const newConversation = this.#db
          .exec(`INSERT INTO conversations (topic_id, messages) VALUES (?, '[]') RETURNING id`, topicRow.id)
          .one()
        conversationId = newConversation.id
        console.log(`[INFO][${stage}] New conversation created: id=${conversationId}`)
      }

      messages.push({ role: "user", content: userMessage })

      const systemPrompt = noteMode
        ? "The user is saving a context note. Acknowledge with exactly one short word."
        : await (async () => {
            const contextParts = []
            if (categoryRow.summary) contextParts.push(`Category context: ${categoryRow.summary}`)
            if (topicRow.summary) contextParts.push(`Topic context: ${topicRow.summary}`)
            if (!contextParts.length)
              contextParts.push(
                "You have no prior context about this topic. Ask the user about their situation if needed.",
              )

            return [
              systemInstruction(this.env),
              `You are a personal assistant helping with: ${category} / ${topicName}.`,
              ...contextParts,
            ].join("\n")
          })()

      const assistantMessage = await runAI(this.env, systemPrompt, messages)

      messages.push({ role: "assistant", content: assistantMessage })

      const lastMsg = (messages[messages.length - 1]?.content || "").slice(0, 200)
      this.#db.exec(
        `UPDATE conversations SET messages = ?, last_message = ? WHERE id = ?`,
        JSON.stringify(messages),
        lastMsg,
        conversationId,
      )
      console.log(`[INFO][${stage}] Conversation updated: id=${conversationId}, messages=${messages.length}`)

      return { response: assistantMessage, conversationId: Number(conversationId), topic: topicName, topicId: Number(topicRow.id) }
    } catch (err) {
      console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Returns all categories and topics. Meant for listing available contexts and their summaries.
   */
  async getCategories(): Promise<CategoryRow[]> {
    const stage = "getCategories"
    try {
      const categories = [
        ...this.#db.exec(`SELECT id, name, summary, updated_at_timestamp FROM categories ORDER BY name`).toArray(),
      ]
      const result = categories.map((cat) => ({
        id: Number(cat.id),
        name: String(cat.name),
        summary: String(cat.summary),
        updated_at_timestamp: Number(cat.updated_at_timestamp || 0),
        topics: [
          ...this.#db
            .exec(
              `SELECT id, name, summary, micro_summary, updated_at_timestamp FROM topics WHERE category_id = ? ORDER BY name`,
              cat.id,
            )
            .toArray(),
        ].map((topic) => ({
          id: Number(topic.id),
          name: String(topic.name),
          summary: String(topic.summary),
          micro_summary: String(topic.micro_summary || ""),
          updated_at_timestamp: Number(topic.updated_at_timestamp || 0),
        })),
      }))
      console.log(`[INFO][${stage}] Fetched ${result.length} categories`)
      return result
    } catch (err) {
      console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Incrementally updates a topic's summary by processing only new conversations since the last summary update. The summary fold and the one-sentence micro summary distillation are separate AI calls.
   */
  async updateTopicSummaryIncremental(topicId: number): Promise<void> {
    const stage = "updateTopicSummaryIncremental"
    try {
      const topic = this.#db
        .exec(
          `SELECT t.id, t.name, t.summary, t.updated_at_timestamp, c.name as category_name
         FROM topics t
         JOIN categories c ON c.id = t.category_id
         WHERE t.id = ?`,
          topicId,
        )
        .one()

      if (!topic) throw new Error(`[${stage}] Topic not found: ${topicId}`)

      const lastSummaryAt = topic.updated_at_timestamp || 0
      const conversations = [
        ...this.#db
          .exec(
            `SELECT id, messages FROM conversations
         WHERE topic_id = ? AND created_at_timestamp >= ?
         ORDER BY created_at_timestamp ASC`,
            topicId,
            lastSummaryAt,
          )
          .toArray(),
      ]

      if (!conversations.length) {
        console.log(`[INFO][${stage}] No new conversations for topic=${topicId}`)
        return
      }

      const newMessages = this.#parseMessages(conversations)

      if (!newMessages.length) {
        console.log(`[INFO][${stage}] No new messages for topic=${topicId}`)
        return
      }

      const summaryPrompt = [
        systemInstruction(this.env),
        topic.summary ? `Existing summary: ${topic.summary}` : null,
        `Update the summary by incorporating the following NEW messages. Category: ${topic.category_name}, Topic: ${topic.name}. Messages are labeled with role fields ("user" and "assistant"). Prioritize "user" messages — they represent confirmed information and intent. "assistant" messages are speculative; only include their content if the user explicitly agreed or confirmed it. Be conservative — avoid adding unconfirmed assumptions.`,
      ]
        .filter(Boolean)
        .join("\n")

      console.log(
        `[INFO][${stage}] Updating topic summary: id=${topic.id}, name=${topic.name}, newMessages=${newMessages.length}`,
      )

      const newSummary = await runAI(this.env, summaryPrompt, [{ role: "user", content: JSON.stringify(newMessages) }])

      this.#db.exec(
        `UPDATE topics SET summary = ?, updated_at_timestamp = strftime('%s', 'now') WHERE id = ?`,
        newSummary,
        topic.id,
      )
      console.log(`[INFO][${stage}] Topic summary updated: topic=${topic.id}, name=${topic.name}`)

      const micro = (await distillMicroSummary(this.env, newSummary)) || firstSentence(newSummary)
      this.#db.exec(`UPDATE topics SET micro_summary = ? WHERE id = ?`, micro, topic.id)
      console.log(`[INFO][${stage}] Topic micro summary updated: topic=${topic.id}`)
    } catch (err) {
      console.error(`[ERROR][${stage}] Failed to update topic summary: ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Incrementally updates a category's summary by processing only topics that have been updated since the last category summary update.
   */
  async updateCategorySummaryIncremental(categoryId: number): Promise<void> {
    const stage = "updateCategorySummaryIncremental"
    try {
      const category = this.#db
        .exec(`SELECT id, name, summary, updated_at_timestamp FROM categories WHERE id = ?`, categoryId)
        .one()

      if (!category) throw new Error(`[${stage}] Category not found: ${categoryId}`)

      const lastCatSummaryAt = category.updated_at_timestamp || 0
      const updatedTopics = [
        ...this.#db
          .exec(
            `SELECT id, name, summary
         FROM topics
         WHERE category_id = ? AND summary != '' AND updated_at_timestamp >= ?`,
            categoryId,
            lastCatSummaryAt,
          )
          .toArray(),
      ]

      if (!updatedTopics.length) {
        console.log(`[INFO][${stage}] No updated topics for category=${categoryId}`)
        return
      }

      const topicSummariesText = updatedTopics.map((t) => `- ${t.name}: ${t.summary}`).join("\n\n")

      const summaryPrompt = [
        systemInstruction(this.env),
        category.summary ? `Existing category summary: ${category.summary}` : null,
        `Update the category summary by incorporating the following UPDATED topic summaries. The category summary should provide a high-level overview, highlighting common themes and key areas of focus.`,
        `Updated topic summaries:\n${topicSummariesText}`,
      ]
        .filter(Boolean)
        .join("\n\n")

      console.log(
        `[INFO][${stage}] Updating category summary: id=${category.id}, name=${category.name}, updatedTopics=${updatedTopics.length}`,
      )

      const newSummary = await runAI(this.env, summaryPrompt, [
        { role: "user", content: "Generate the updated category summary." },
      ])

      this.#db.exec(
        `UPDATE categories SET summary = ?, updated_at_timestamp = strftime('%s', 'now') WHERE id = ?`,
        newSummary,
        category.id,
      )
      console.log(`[INFO][${stage}] Category summary updated: category=${category.id}, name=${category.name}`)
    } catch (err) {
      console.error(`[ERROR][${stage}] Failed to update category summary: ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Updates or clears a summary for a category or topic. Empty summary = forget; topics also reset their micro summary. For topics an optional microSummary overrides the locally derived first-sentence default; it is ignored for categories.
   */
  updateSummary(type: "category" | "topic", id: number, summary: string, microSummary?: string): { success: true } {
    const stage = "updateSummary"
    try {
      if (!["category", "topic"].includes(type)) throw new Error(`[${stage}] Invalid type: ${type}`)
      if (typeof id !== "number" || id <= 0) throw new Error(`[${stage}] Invalid id: ${id}`)

      const timestamp = summary === "" ? 0 : Math.floor(Date.now() / 1000)
      if (type === "category") {
        this.#db.exec(`UPDATE categories SET summary = ?, updated_at_timestamp = ? WHERE id = ?`, summary, timestamp, id)
      } else {
        const micro = summary === "" ? "" : microSummary?.trim() || firstSentence(summary)
        this.#db.exec(`UPDATE topics SET summary = ?, micro_summary = ?, updated_at_timestamp = ? WHERE id = ?`, summary, micro, timestamp, id)
      }
      const updated = this.#db.exec(`SELECT changes() AS count`).one().count
      if (!updated) throw new Error(`[${stage}] ${type} not found: ${id}`)

      console.log(`[INFO][${stage}] ${type} summary updated: id=${id}`)
      return { success: true }
    } catch (err) {
      console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Renames a category. Returns "name_taken" when another category already uses the name; its topics, summaries, and conversations are unaffected.
   */
  renameCategory(id: number, name: string): MutationResult {
    const stage = "renameCategory"
    try {
      const trimmed = name?.trim()
      if (typeof id !== "number" || id <= 0 || !trimmed) throw new Error(`[${stage}] Invalid input: id and name are required`)

      const [category] = this.#db.exec(`SELECT id FROM categories WHERE id = ?`, id).toArray()
      if (!category) {
        console.log(`[INFO][${stage}] Category not found: id=${id}`)
        return { status: "not_found" }
      }

      const [conflict] = this.#db.exec(`SELECT id FROM categories WHERE name = ? AND id != ?`, trimmed, id).toArray()
      if (conflict) {
        console.log(`[INFO][${stage}] Category name already exists: ${trimmed}`)
        return { status: "name_taken" }
      }

      this.#db.exec(`UPDATE categories SET name = ? WHERE id = ?`, trimmed, id)
      console.log(`[INFO][${stage}] Category renamed: id=${id}, name=${trimmed}`)
      return { status: "ok" }
    } catch (err) {
      console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Renames a topic within its category. Returns "name_taken" when a sibling topic already uses the name; its summary and conversations are unaffected.
   */
  renameTopic(id: number, name: string): MutationResult {
    const stage = "renameTopic"
    try {
      const trimmed = name?.trim()
      if (typeof id !== "number" || id <= 0 || !trimmed) throw new Error(`[${stage}] Invalid input: id and name are required`)

      const [topic] = this.#db.exec(`SELECT id, category_id FROM topics WHERE id = ?`, id).toArray()
      if (!topic) {
        console.log(`[INFO][${stage}] Topic not found: id=${id}`)
        return { status: "not_found" }
      }

      const [conflict] = this.#db
        .exec(`SELECT id FROM topics WHERE category_id = ? AND name = ? AND id != ?`, topic.category_id, trimmed, id)
        .toArray()
      if (conflict) {
        console.log(`[INFO][${stage}] Topic name already exists in category=${topic.category_id}: ${trimmed}`)
        return { status: "name_taken" }
      }

      this.#db.exec(`UPDATE topics SET name = ? WHERE id = ?`, trimmed, id)
      console.log(`[INFO][${stage}] Topic renamed: id=${id}, name=${trimmed}`)
      return { status: "ok" }
    } catch (err) {
      console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Deletes a category with all of its topics and conversations. Cascades are explicit so the result never depends on foreign-key enforcement.
   */
  deleteCategory(id: number): MutationResult {
    const stage = "deleteCategory"
    try {
      if (typeof id !== "number" || id <= 0) throw new Error(`[${stage}] Invalid id: ${id}`)

      this.#db.exec(`DELETE FROM conversations WHERE topic_id IN (SELECT id FROM topics WHERE category_id = ?)`, id)
      this.#db.exec(`DELETE FROM topics WHERE category_id = ?`, id)
      this.#db.exec(`DELETE FROM categories WHERE id = ?`, id)
      const deleted = this.#db.exec(`SELECT changes() AS count`).one().count
      if (!deleted) {
        console.log(`[INFO][${stage}] Category not found: id=${id}`)
        return { status: "not_found" }
      }

      console.log(`[INFO][${stage}] Category deleted with topics and conversations: id=${id}`)
      return { status: "ok" }
    } catch (err) {
      console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Deletes a topic with all of its conversations.
   */
  deleteTopic(id: number): MutationResult {
    const stage = "deleteTopic"
    try {
      if (typeof id !== "number" || id <= 0) throw new Error(`[${stage}] Invalid id: ${id}`)

      this.#db.exec(`DELETE FROM conversations WHERE topic_id = ?`, id)
      this.#db.exec(`DELETE FROM topics WHERE id = ?`, id)
      const deleted = this.#db.exec(`SELECT changes() AS count`).one().count
      if (!deleted) {
        console.log(`[INFO][${stage}] Topic not found: id=${id}`)
        return { status: "not_found" }
      }

      console.log(`[INFO][${stage}] Topic deleted with conversations: id=${id}`)
      return { status: "ok" }
    } catch (err) {
      console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Updates all summaries incrementally. Iterates through all topics and categories,
   * processing only new conversations since last summary update. Also backfills missing
   * topic micro summaries for topics that already have a summary — this heals databases
   * created before micro summaries existed.
   */
  async updateAllSummaries(): Promise<void> {
    const stage = "updateAllSummaries"
    try {
      const topics = [...this.#db.exec(`SELECT id FROM topics`).toArray()]
      for (const topic of topics) {
        await this.updateTopicSummaryIncremental(Number(topic.id))
      }

      const microless = [...this.#db.exec(`SELECT id, summary FROM topics WHERE summary != '' AND micro_summary = ''`).toArray()]
      for (const topic of microless) {
        const summary = String(topic.summary)
        const micro = (await distillMicroSummary(this.env, summary)) || firstSentence(summary)
        this.#db.exec(`UPDATE topics SET micro_summary = ? WHERE id = ?`, micro, Number(topic.id))
      }
      if (microless.length) console.log(`[INFO][${stage}] Backfilled ${microless.length} topic micro summaries`)

      const categories = [...this.#db.exec(`SELECT id FROM categories`).toArray()]
      for (const category of categories) {
        await this.updateCategorySummaryIncremental(Number(category.id))
      }

      console.log(`[INFO][${stage}] All summaries updated successfully`)
    } catch (err) {
      console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Returns all conversations with category, topic, timestamp, and last message preview, ordered by most recent.
   */
  async listConversations(
    category: string,
    topic: string,
  ): Promise<ConversationListEntry[]> {
    const stage = "listConversations"
    let sql = `
        SELECT c.id, c.created_at_timestamp, c.last_message, cat.name as category, t.name as topic
        FROM conversations c
        JOIN topics t ON t.id = c.topic_id
        JOIN categories cat ON cat.id = t.category_id
      `
    const params: string[] = []
    const conditions: string[] = []
    if (category?.trim()) {
      conditions.push(`cat.name = ?`)
      params.push(category.trim())
    }
    if (topic?.trim()) {
      conditions.push(`t.name = ?`)
      params.push(topic.trim())
    }
    if (conditions.length) sql += `WHERE ${conditions.join(" AND ")} `
    sql += `ORDER BY c.created_at_timestamp DESC LIMIT 50`
    const rows = [...this.#db.exec(sql, ...params).toArray()]
    const result = rows.map((r) => {
      return {
        id: Number(r.id),
        category: String(r.category),
        topic: String(r.topic),
        created_at: Number(r.created_at_timestamp),
        last_message: (String(r.last_message) || "").slice(0, 80),
      }
    })
    console.log(`[INFO][${stage}] Listed ${result.length} conversations`)
    return result
  }

  /**
   * Returns all conversations of one category/topic pair with their messages, ascending by creation time — a single-request replacement for the frontend's list + per-conversation detail fetches. Unknown category/topic names return an empty array.
   */
  async topicConversations(category: string, topic: string): Promise<TopicStreamEntry[]> {
    const stage = "topicConversations"
    try {
      const rows = [
        ...this.#db
          .exec(
            `SELECT c.id, c.created_at_timestamp, c.messages
             FROM conversations c
             JOIN topics t ON t.id = c.topic_id
             JOIN categories cat ON cat.id = t.category_id
             WHERE cat.name = ? AND t.name = ?
             ORDER BY c.created_at_timestamp ASC`,
            category.trim(),
            topic.trim(),
          )
          .toArray(),
      ]
      const result = rows.map((row) => {
        let messages: AiConversationEntry[] = []
        try {
          messages = AiConversationEntry.array().parse(JSON.parse(String(row.messages || "[]")))
        } catch (err) {
          console.error(`[ERROR][${stage}] Failed to parse messages for conversation=${row.id}: ${errorMessage(err)}`)
        }
        return { id: Number(row.id), created_at: Number(row.created_at_timestamp || 0), messages }
      })
      console.log(`[INFO][${stage}] Fetched ${result.length} conversations for ${category}/${topic}`)
      return result
    } catch (err) {
      console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Deletes a conversation by id.
   */
  async deleteConversation(id: number): Promise<{ success: true }> {
    const stage = "deleteConversation"
    try {
      this.#db.exec(`DELETE FROM conversations WHERE id = ?`, id)
      console.log(`[INFO][${stage}] Deleted conversation: id=${id}`)
      return { success: true }
    } catch (err) {
      console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Edits the content of one message in an unsummarized conversation, keeping its role. Recomputes last_message when the edited message is the latest one.
   */
  updateMessage(id: number, index: number, content: string): MutationResult {
    const stage = "updateMessage"
    try {
      const loaded = this.#loadMutableConversation(id)
      if (typeof loaded === "string") return { status: loaded }

      const target = loaded.messages[index]
      if (!target) {
        console.log(`[INFO][${stage}] Message index out of range: conversation=${id}, index=${index}`)
        return { status: "not_found" }
      }

      loaded.messages[index] = { role: target.role, content: content.trim() }
      const lastMessage = (loaded.messages[loaded.messages.length - 1]?.content || "").slice(0, 200)
      this.#db.exec(
        `UPDATE conversations SET messages = ?, last_message = ? WHERE id = ?`,
        JSON.stringify(loaded.messages),
        lastMessage,
        id,
      )
      console.log(`[INFO][${stage}] Message updated: conversation=${id}, index=${index}`)
      return { status: "ok" }
    } catch (err) {
      console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Deletes one message from an unsummarized conversation. Deleting the last remaining message deletes the conversation.
   */
  deleteMessage(id: number, index: number): MutationResult {
    const stage = "deleteMessage"
    try {
      const loaded = this.#loadMutableConversation(id)
      if (typeof loaded === "string") return { status: loaded }

      if (!Number.isInteger(index) || index < 0 || index >= loaded.messages.length) {
        console.log(`[INFO][${stage}] Message index out of range: conversation=${id}, index=${index}`)
        return { status: "not_found" }
      }

      loaded.messages.splice(index, 1)

      if (!loaded.messages.length) {
        this.#db.exec(`DELETE FROM conversations WHERE id = ?`, id)
        console.log(`[INFO][${stage}] Conversation deleted after removing its last message: id=${id}`)
        return { status: "ok" }
      }

      const lastMessage = (loaded.messages[loaded.messages.length - 1]?.content || "").slice(0, 200)
      this.#db.exec(
        `UPDATE conversations SET messages = ?, last_message = ? WHERE id = ?`,
        JSON.stringify(loaded.messages),
        lastMessage,
        id,
      )
      console.log(`[INFO][${stage}] Message deleted: conversation=${id}, index=${index}`)
      return { status: "ok" }
    } catch (err) {
      console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
      throw err
    }
  }

  /**
   * Returns a single conversation with its messages, or null when the conversation does not exist.
   */
  async getConversation(id: number): Promise<ConversationDetail | null> {
    const stage = "getConversation"
    const row = this.#db
      .exec(
        `
        SELECT c.id, c.messages, cat.name as category, t.name as topic
        FROM conversations c
        JOIN topics t ON t.id = c.topic_id
        JOIN categories cat ON cat.id = t.category_id
        WHERE c.id = ?
      `,
        id,
      )
      .toArray()[0]
    if (!row) {
      console.log(`[INFO][${stage}] Conversation not found: id=${id}`)
      return null
    }
    const messages = JSON.parse(String(row.messages || "[]")) as AiConversationEntry[]

    console.log(`[INFO][${stage}] Fetched conversation: id=${id}, messages=${messages.length}`)
    return { id: Number(row.id), category: String(row.category), topic: String(row.topic), messages }
  }

}

/**
 * Cloudflare Worker handler for scheduled (cron) events and HTTP requests.
 * On each scheduled run, gets a singleton instance of the `ASSISTANT_DO` and updates summaries by processing unsummarized conversations.
 */
export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const stage = "scheduled"
    try {
      const id = env.ASSISTANT_DO.idFromName("singleton")
      const stub = env.ASSISTANT_DO.get(id)
      await stub.updateAllSummaries()
      console.log(`[INFO][${stage}] Scheduled summary update complete`)
    } catch (err) {
      console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
      throw err
    }
  },
  /**
   * HTTP request handler delegating to the route table in ./routes.
   */
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return handleRequest(request, env)
  },
}