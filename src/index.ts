import { DurableObject } from "cloudflare:workers"
import * as z from "zod"

/**
 * Cloudflare Worker that uses SQLite-backed Durable Object. Works as a personal LLM assistant. It stores conversations and uses summed up context when generating responses.
 *
 * Features:
 * - Stores conversations by predifined category and topic (e.g., "work": "project X context", "personal": "choosing a country to travel", "languages": "Ukrainian").
 * - Stores a summary-context for each category and topic. Adjusts these daily by processing new conversations.
 * - When new conversation is started and category or topic is non predifined, it will be created and added to the list of categories.
 * - Endpoint to fetch all categories and topics, and their summaries.
 *
 * ## Best Practices
 * - Simplicity, reliability, and efficiency.
 * - Stick to JSDoc for specifications and documentation, but not type definitions.
 * - Robust error handling and logging techniques with succinct messages. Wrapping each data processing stage in a try-catch block, validating all inputs and outputs, and using `INFO` and `ERROR` levels with detailed contextual information, such as processing stage, task name, etc.
 * - Concise code with minimal formatting and indentation, which prioritizes descriptive element naming and log messages over inline comments to achieve readability.
 */

function isError(err: unknown) {
  return err instanceof Error
}

const AiConversationEntry = z.object({
  role: z.string(),
  content: z.string(),
})

type AiConversationEntry = z.infer<typeof AiConversationEntry>

const AiResponse = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string(),
      }),
    }),
  ),
})

type AiResponse = z.infer<typeof AiResponse>

const Category = z.object({
  id: z.number(),
  name: z.string(),
  summary: z.string().default(""),
  updated_at_timestamp: z.number().nullable(),
})

type Category = z.infer<typeof Category>

const Topic = z.object({
  id: z.number(),
  category_id: z.number(),
  name: z.string(),
  summary: z.string().default(""),
  updated_at_timestamp: z.number().nullable(),
})

type Topic = z.infer<typeof Topic>

const Conversation = z.object({
  id: z.number(),
  topic_id: z.number(),
  messages: z.string().default("[]"),
  last_message: z.string().default(""),
  created_at_timestamp: z.number().nullable(),
})

type Conversation = z.infer<typeof Conversation>

export interface Env {
  ASSISTANT_DO: DurableObjectNamespace<AssistantDurableObject>
  API_KEY: string
  OPENROUTER_API_KEY?: string
}

export class AssistantDurableObject extends DurableObject {
  #db

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.#db = state.storage.sql
    this.initSchema()
  }

  // Effective TypeScript — Item 3: Understand That Code Generation Is Independent of Types
  // The DDL strings and PRAGMA migrations are pure runtime behavior — invisible to the type checker, so keep them covered by tests (Item 77: type checking and unit testing are complementary).
  // Item 74: Know How to Reconstruct Types at Runtime — PRAGMA table_info rows come back untyped; `col.name` only works after runtime narrowing/casting.

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

    const convColumns = this.#db.exec(`PRAGMA table_info(conversations)`).toArray()
    if (!convColumns.some((col) => col.name === "last_message")) {
      this.#db.exec(`ALTER TABLE conversations ADD COLUMN last_message TEXT NOT NULL DEFAULT ''`)
    }

    if (!convColumns.some((col) => col.name === "context_categories")) {
      this.#db.exec(`ALTER TABLE conversations ADD COLUMN context_categories TEXT NOT NULL DEFAULT '[]'`)
    }
  }

  /**
   * Runs the AI model with the given system prompt and user messages.
   */
  async #runAI(systemPrompt: string, conversation: AiConversationEntry[]): Promise<string> {
    const messages = [{ role: "system", content: systemPrompt }, ...conversation]

    const provider = this.env.AI_PROVIDER || "workers-ai"
    const res =
      provider === "openrouter"
        ? await this.#callOpenRouter(messages)
        : await this.env.AI.run(this.env.AI_MODEL_WORKERS_AI, {
            messages: messages as unknown as ChatCompletionMessageParam[],
          })

    const aiResponse = AiResponse.safeParse(res)

    if (!aiResponse.success || !aiResponse.data.choices[0]) {
      throw new Error("AI returned unexpected object structure.")
    }

    const content = aiResponse.data.choices[0].message.content
    if (!content) {
      throw new Error("AI returned empty response or unexpected object structure.")
    }
    return content
  }

  /**
   * Calls the OpenRouter API with the provided messages.
   */
  async #callOpenRouter(messages: AiConversationEntry[]): Promise<unknown> {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.env.AI_MODEL_OPENROUTER, messages }),
    })
    if (!resp.ok) throw new Error(`OpenRouter request failed: ${resp.status} ${await resp.text()}`)
    return resp.json()
  }

  /**
   * Parses the messages from conversations, handling any JSON parsing errors gracefully.
   */
  #parseMessages(conversations: Conversation[]): AiConversationEntry[] {
    return conversations.flatMap((conv) => {
      try {
        return AiConversationEntry.parse(conv.messages)
      } catch {
        console.error(`[ERROR] Failed to parse messages for conversation=${conv.id}`)
        return []
      }
    })
  }

  // Effective TypeScript — Item 25: Understand Evolving Types
  // `messages = []`, `contextParts = []`, and `let conversationId` all start implicit and evolve; the book: recognize evolving types, but prefer explicit annotations (Message[] / string[] / number) for better checking.
  // Item 32: Avoid Including null or undefined in Type Aliases — the non-Error swallow path makes this `Promise<{response, conversationId} | undefined>`; Item 33: push that undefined to the perimeter (rethrow always, like the other catch blocks).

  /**
   * Processes a user message within a specified category and topic, generates an AI response using the stored conversation history and summary context, and updates the conversation. If the category or topic doesn't exist, it will be created.
   *
   * Reuses the topic's latest conversation only if it was created at or after the topic's last
   * summary update (i.e. it hasn't been folded into the summary yet). Otherwise, since the
   * existing conversation is considered already summarized, a new conversation is started.
   */
  async chat(category: string, topic: string, userMessage: string, noteMode: boolean = false) {
    const stage = "chat"
    try {
      if (!category?.trim() || !topic?.trim() || !userMessage?.trim())
        throw new Error(`[${stage}] Invalid input: category, topic, and userMessage are required`)

      const categoryRow = this.#db
        .exec(
          `INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id, summary`,
          category.trim(),
        )
        .one()
      console.log(`[INFO][${stage}] Category resolved: id=${categoryRow.id}, name=${category}`)

      const topicRow = this.#db
        .exec(
          `INSERT INTO topics (category_id, name) VALUES (?, ?) ON CONFLICT(category_id, name) DO UPDATE SET name=name RETURNING id, summary, updated_at_timestamp`,
          categoryRow.id,
          topic.trim(),
        )
        .one()
      console.log(`[INFO][${stage}] Topic resolved: id=${topicRow.id}, name=${topic}`)

      const [existingConversation] = this.#db
        .exec(
          `SELECT id, messages, created_at_timestamp FROM conversations WHERE topic_id = ? ORDER BY created_at_timestamp DESC LIMIT 1`,
          topicRow.id,
        )
        .toArray()

      const isConversationFresh =
        existingConversation &&
        (!topicRow.updated_at_timestamp || existingConversation.created_at_timestamp >= topicRow.updated_at_timestamp)

      let conversationId
      let messages: AiConversationEntry[] = []

      if (isConversationFresh) {
        conversationId = existingConversation.id
        try {
          messages = JSON.parse(String(existingConversation.messages))
        } catch {
          console.error(`[ERROR][${stage}] Failed to parse messages for conversation=${conversationId}`)
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
              this.env.AI_SYSTEM_INSTRUCTION,
              `You are a personal assistant helping with: ${category} / ${topic}.`,
              ...contextParts,
            ].join("\n")
          })()

      const assistantMessage = await this.#runAI(systemPrompt, messages)

      messages.push({ role: "assistant", content: assistantMessage })

      const lastMsg = (messages[messages.length - 1]?.content || "").slice(0, 200)
      this.#db.exec(
        `UPDATE conversations SET messages = ?, last_message = ? WHERE id = ?`,
        JSON.stringify(messages),
        lastMsg,
        conversationId,
      )
      console.log(`[INFO][${stage}] Conversation updated: id=${conversationId}, messages=${messages.length}`)

      return { response: assistantMessage, conversationId: Number(conversationId) }
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] ${err.message}`)
        throw err
      }
    }
  }

  /**
   * Returns all categories and topics. Meant for listing available contexts and their summaries.
   */
  async getCategories() {
    const stage = "getCategories"
    try {
      const categories = [
        ...this.#db.exec(`SELECT id, name, summary, updated_at_timestamp FROM categories ORDER BY name`).toArray(),
      ]
      const result = categories.map((cat) => {
        const topics = [
          ...this.#db
            .exec(
              `SELECT id, name, summary, updated_at_timestamp FROM topics WHERE category_id = ? ORDER BY name`,
              cat.id,
            )
            .toArray(),
        ]
        return { ...cat, topics }
      })
      console.log(`[INFO][${stage}] Fetched ${result.length} categories`)
      return result
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] ${err.message}`)
        throw err
      }
    }
  }

  // Effective TypeScript — Item 36: Use a Distinct Type for Special Values
  // `topic.updated_at_timestamp || 0` uses 0 as the "never summarized" sentinel — the book prefers null/undefined as the special value over 0, -1, or "".
  // Item 40: Prefer Imprecise Types to Inaccurate Types — SQLite rows are loosely typed by necessity; a simple row interface beats a clever-but-wrong model.

  /**
   * Incrementally updates a topic's summary by processing only new conversations since the last summary update.
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
        this.env.AI_SYSTEM_INSTRUCTION,
        topic.summary ? `Existing summary: ${topic.summary}` : null,
        `Update the summary by incorporating the following NEW messages. Category: ${topic.category_name}, Topic: ${topic.name}. Messages are labeled with role fields ("user" and "assistant"). Prioritize "user" messages — they represent confirmed information and intent. "assistant" messages are speculative; only include their content if the user explicitly agreed or confirmed it. Be conservative — avoid adding unconfirmed assumptions.`,
      ]
        .filter(Boolean)
        .join("\n")

      console.log(
        `[INFO][${stage}] Updating topic summary: id=${topic.id}, name=${topic.name}, newMessages=${newMessages.length}`,
      )

      const newSummary = await this.#runAI(summaryPrompt, [{ role: "user", content: JSON.stringify(newMessages) }])

      this.#db.exec(
        `UPDATE topics SET summary = ?, updated_at_timestamp = strftime('%s', 'now') WHERE id = ?`,
        newSummary,
        topic.id,
      )
      console.log(`[INFO][${stage}] Topic summary updated: topic=${topic.id}, name=${topic.name}`)
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] Failed to update topic summary: ${err.message}`)
      }
      throw err
    }
  }

  // Effective TypeScript — Item 26: Use Functional Constructs and Libraries to Help Types Flow
  // `[a, b ?? null, c].filter(Boolean)` does NOT remove null from the element type in TS — use flatMap or an is-string type predicate to keep types flowing.
  // Item 15: Use Type Operations and Generic Types to Avoid Repeating Yourself — prompt assembly mirrors updateTopicSummaryIncremental; a shared buildSummaryPrompt helper (typed over "topic" | "category") covers both.

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
        this.env.AI_SYSTEM_INSTRUCTION,
        category.summary ? `Existing category summary: ${category.summary}` : null,
        `Update the category summary by incorporating the following UPDATED topic summaries. The category summary should provide a high-level overview, highlighting common themes and key areas of focus.`,
        `Updated topic summaries:\n${topicSummariesText}`,
      ]
        .filter(Boolean)
        .join("\n\n")

      console.log(
        `[INFO][${stage}] Updating category summary: id=${category.id}, name=${category.name}, updatedTopics=${updatedTopics.length}`,
      )

      const newSummary = await this.#runAI(summaryPrompt, [
        { role: "user", content: "Generate the updated category summary." },
      ])

      this.#db.exec(
        `UPDATE categories SET summary = ?, updated_at_timestamp = strftime('%s', 'now') WHERE id = ?`,
        newSummary,
        category.id,
      )
      console.log(`[INFO][${stage}] Category summary updated: category=${category.id}, name=${category.name}`)
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] Failed to update category summary: ${err.message}`)
      }
      throw err
    }
  }

  /**
   * Updates or clears a summary for a category or topic. Empty summary = forget.
   */
  updateSummary(type: "category" | "topic", id: number, summary: string): { success: boolean } {
    const stage = "updateSummary"
    try {
      if (!["category", "topic"].includes(type)) throw new Error(`[${stage}] Invalid type: ${type}`)
      if (typeof id !== "number" || id <= 0) throw new Error(`[${stage}] Invalid id: ${id}`)

      const table = type === "category" ? "categories" : "topics"
      const timestamp = summary === "" ? 0 : Math.floor(Date.now() / 1000)
      this.#db.exec(`UPDATE ${table} SET summary = ?, updated_at_timestamp = ? WHERE id = ?`, summary, timestamp, id)
      const updated = this.#db.exec(`SELECT changes() AS count`).one().count
      if (!updated) throw new Error(`[${stage}] ${type} not found: ${id}`)

      console.log(`[INFO][${stage}] ${type} summary updated: id=${id}`)
      return { success: true }
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] ${err.message}`)
        throw err
      }
      return { success: false }
    }
  }

  /**
   * Updates all summaries incrementally. Iterates through all topics and categories,
   * processing only new conversations since last summary update.
   * @returns {Promise<void>}
   */
  async updateAllSummaries() {
    const stage = "updateAllSummaries"
    try {
      const topics = [...this.#db.exec(`SELECT id FROM topics`).toArray()]
      for (const topic of topics) {
        const parsedTopic = Topic.pick({ id: true }).safeParse(topic)
        if (!parsedTopic.success) {
          throw new Error("Failed to parse topic for summarization")
        }
        await this.updateTopicSummaryIncremental(parsedTopic.data.id)
      }

      const categories = [...this.#db.exec(`SELECT id FROM categories`).toArray()]
      for (const category of categories) {
        const parsedCategory = Category.pick({ id: true }).safeParse(category)
        if (!parsedCategory.success) {
          throw new Error("Failed to parse category for summarization")
        }
        await this.updateCategorySummaryIncremental(parsedCategory.data.id)
      }

      console.log(`[INFO][${stage}] All summaries updated successfully`)
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] ${err.message}`)
        throw err
      }
    }
  }

  // Effective TypeScript — Item 25: Understand Evolving Types
  // `const params = []` / `const conditions = []` evolve via .push() — declare string[] / string[] up front when converting.
  // Item 35: Prefer More Precise Alternatives to String Types — category/topic filters are free-form strings; prefer unions or keyof where the domain is narrower.

  /**
   * Returns all conversations with category, topic, timestamp, and last message preview, ordered by most recent.
   */
  async listConversations(category: string, topic: string): Promise<Conversation[]> {
    const stage = "listConversations"
    let sql = `
        SELECT c.id, c.created_at_timestamp, c.last_message, cat.name as category, t.name as topic
        FROM conversations c
        JOIN topics t ON t.id = c.topic_id
        JOIN categories cat ON cat.id = t.category_id
      `
    const params = []
    const conditions = []
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

  // Effective TypeScript — Item 32: Avoid Including null or undefined in Type Aliases
  // The non-Error swallow path makes this `Promise<{success: boolean} | undefined>` — an implicit union; either always return a result or always throw (Item 33: push nulls to the perimeter).

  /**
   * Deletes a conversation by id.
   * @param {number} id
   * @returns {Promise<{success: boolean} | undefined>}
   */
  async deleteConversation(id) {
    const stage = "deleteConversation"
    try {
      this.#db.exec(`DELETE FROM conversations WHERE id = ?`, id)
      console.log(`[INFO][${stage}] Deleted conversation: id=${id}`)
      return { success: true }
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] ${err.message}`)
        throw err
      }
    }
  }

  // Effective TypeScript — Item 29: Prefer Types That Always Represent Valid States
  // The empty `catch {}` quietly maps "corrupt context_categories" to "no context" — decide if that's a valid state (model it, e.g. `contextCategories?: string[]`) or an error to propagate.
  // Item 74: Know How to Reconstruct Types at Runtime — JSON.parse of row.messages/context_categories needs runtime validation, not trust.

  /**
   * Returns a single conversation with its messages.
   * @param {number} id
   * @returns {Promise< | undefined>}
   */
  async getConversation(id: number): Promise<Conversation> {
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
      .one()
    if (!row) throw new Error(`Conversation not found: ${id}`)
    const messages = JSON.parse(row.messages)

    console.log(`[INFO][${stage}] Fetched conversation: id=${id}, messages=${messages.length}`)
    return { id: Number(row.id), category: String(row.category), topic: String(row.topic), messages }
  }

  // Effective TypeScript — Item 38: Avoid Repeated Parameters of the Same Type
  // (category, topic, messages) — three loose consecutive params; the book prefers fewer params with distinct types, or a single object parameter.
  // Item 30: Be Liberal in What You Accept and Strict in What You Produce — liberal message input, strict {conversationId: number} output.

  /**
   * Stores messages as a new conversation in the given category/topic without calling AI.
   * Creates the category and topic if they don't exist.
   */
  async storeConversationMessage(
    category: string,
    topic: string,
    messages: AiConversationEntry[],
  ): Promise<{ conversationId: number }> {
    const stage = "storeConversationMessage"
    try {
      const categoryRow = this.#db
        .exec(
          `INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id`,
          category.trim(),
        )
        .one()

      const topicRow = this.#db
        .exec(
          `INSERT INTO topics (category_id, name) VALUES (?, ?) ON CONFLICT(category_id, name) DO UPDATE SET name=name RETURNING id`,
          categoryRow.id,
          topic.trim(),
        )
        .one()

      const conv = this.#db
        .exec(
          `INSERT INTO conversations (topic_id, messages) VALUES (?, ?) RETURNING id`,
          topicRow.id,
          JSON.stringify(messages),
        )
        .one()

      if (!conv) {
        throw new Error("Failed to store conversation")
      }

      console.log(
        `[INFO][${stage}] Stored ${messages.length} messages in ${category}/${topic}, conversation=${conv.id}`,
      )
      return { conversationId: Number(conv.id) }
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] ${err.message}`)
        throw err
      }
    }
  }
}

// Effective TypeScript — Item 24: Understand How Context Is Used in Type Inference
// Annotating this object as ExportedHandler<Env> gives scheduled/fetch contextual parameter types — context flows in, so the @param lines below become redundant (Item 31).

/**
 * @exports default
 * Cloudflare Worker handler for scheduled (cron) events and HTTP requests.
 */
export default {
  // Effective TypeScript — Item 31: Don't Repeat Type Information in Documentation
  // With ExportedHandler<Env> context, the @param lines here restate inferable types — keep the behavior docs, drop the type restatements (Item 18: avoid cluttering code with inferable types).

  /**
   * On each scheduled run, gets a singleton instance of the `ASSISTANT_DO` and updates summaries by processing unsummarized conversations.
   */
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const stage = "scheduled"
    try {
      const id = env.ASSISTANT_DO.idFromName("singleton")
      const stub = env.ASSISTANT_DO.get(id)
      await stub.updateAllSummaries()
      console.log(`[INFO][${stage}] Scheduled summary update complete`)
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] ${err.message}`)
        throw err
      }
    }
  },
  // Effective TypeScript — Item 30: Be Liberal in What You Accept and Strict in What You Produce
  // Inputs arrive raw (JSON bodies, query params — broad); every route returns exactly Response.json with a fixed shape (narrow).
  // Item 22: Understand Type Narrowing — each method+pathname if-check narrows the request before dispatch.

  /**
   * HTTP request handler that routes requests to chat, category, conversation, and summary management endpoints. Validates API key authorization and processes GET, POST, and DELETE methods.
   */
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const stage = "fetch"
    try {
      const url = new URL(request.url)
      const stub = env.ASSISTANT_DO.getByName("singleton")

      const authHeader = request.headers.get("Authorization")
      const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null
      if (!apiKey || apiKey !== env.API_KEY || !env.API_KEY) {
        return Response.json({ error: "Unauthorized" }, { status: 401 })
      }

      // Effective TypeScript — Item 5: Limit Use of the any Type
      // `await request.json()` is any — parse, destructure, and guard right here keeps any at the narrowest scope (Item 43) and never lets it escape into stub.chat's parameters.

      /**
       * POST /chat - Sends a message to the AI assistant and returns a response with optional context from other topics.
       * @param {string} category - The category of the topic
       * @param {string} topic - The topic to chat about
       * @param {string} message - The message to send to the AI
       * @param {boolean} [noteMode] - Whether to enable note mode
       * @returns {Promise<Object>} Chat response from the AI assistant
       */
      if (request.method === "POST" && url.pathname === "/chat") {
        let body
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 })
        }
        const { category, topic, message, noteMode } = body ?? {}
        if (!category?.trim() || !topic?.trim() || !message?.trim())
          return Response.json({ error: "category, topic, and message are required" }, { status: 400 })

        console.log(`[INFO][${stage}] Chat request: category=${category}, topic=${topic}, noteMode=${!!noteMode}`)
        const result = await stub.chat(category, topic, message, !!noteMode)
        return Response.json(result)
      }

      // Effective TypeScript — Item 33: Push Null Values to the Perimeter of Your Types
      // `url.searchParams.get()` yields string | null — normalize once at the edge (`|| ""` → trimmed string[]) so the stub sees only strings.
      // Item 67: Export All Types That Appear in Public APIs — the response shape is dumpCategories' exported type.

      /**
       * GET /dump - Full-fidelity JSON dump of categories, topics, and conversations for one-shot migration export.
       * @param {string} [categories] - comma-separated category names to include; empty = all
       * @returns {Promise<Object>} Complete dump payload
       */
      if (request.method === "GET" && url.pathname === "/categories") {
        console.log(`[INFO][${stage}] Fetching categories`)
        const categories = await stub.getCategories()
        return Response.json(categories)
      }

      // Effective TypeScript — Item 37: Limit the Use of Optional Properties
      // Optional filters modeled as `string | undefined` params (not an options object with optional keys); normalize null query params at the edge (Item 33).

      /**
       * GET /conversations - Lists conversations, optionally filtered by category and/or topic.
       * @param {string} [category] - Optional category to filter by
       * @param {string} [topic] - Optional topic to filter by
       * @returns {Promise<Array>} List of conversations
       */
      if (request.method === "GET" && url.pathname === "/conversations") {
        const category = url.searchParams.get("category") || ""
        const topic = url.searchParams.get("topic") || ""
        console.log(
          `[INFO][${stage}] Listing conversations${category ? ` category=${category}` : ""}${topic ? ` topic=${topic}` : ""}`,
        )
        let result
        try {
          result = await stub.listConversations(category, topic)
        } catch (err) {
          if (isError(err)) {
            console.error(`[ERROR][${stage}] ${err.message}`)
            throw err
          }
        }
        return Response.json(result)
      }

      // Effective TypeScript — Item 64: Consider Brands for Nominal Typing
      // After the isInteger check, `convId` is more than a number — a branded ConversationId type would make stub.getConversation(convId) unforgeable.
      // Item 10: Avoid Object Wrapper Types — Number() here is a runtime conversion, not the String/Number annotation trap; still, the validation deserves a typed helper.

      /**
       * GET /conversation - Retrieves a single conversation by ID.
       * @param {number} id - The conversation ID (positive integer, required)
       * @returns {Promise<Object>} Conversation details
       */
      if (request.method === "GET" && url.pathname === "/conversation") {
        const id = url.searchParams.get("id")
        if (!id) return Response.json({ error: "id query parameter is required" }, { status: 400 })
        const convId = Number(id)
        if (!Number.isInteger(convId) || convId <= 0)
          return Response.json({ error: "id must be a positive integer" }, { status: 400 })
        console.log(`[INFO][${stage}] Fetching conversation: id=${convId}`)
        try {
          const result = await stub.getConversation(convId)
          return Response.json(result)
        } catch (err) {
          if (isError(err)) {
            console.error(`[ERROR][${stage}] ${err.message}`)
            throw err
          }
        }
      }

      // Effective TypeScript — Item 45: Hide Unsafe Type Assertions in Well-Typed Functions
      // This id validation duplicates GET /conversation — extract parseConversationId(params): number | null and hide the Number() cast inside it (Item 15: DRY).

      /**
       * DELETE /conversation - Deletes a conversation by ID.
       * @param {number} id - The conversation ID (positive integer, required)
       * @returns {Promise<Object>} Deletion result
       */
      if (request.method === "DELETE" && url.pathname === "/conversation") {
        const id = url.searchParams.get("id")
        if (!id) return Response.json({ error: "id query parameter is required" }, { status: 400 })
        const convId = Number(id)
        if (!Number.isInteger(convId) || convId <= 0)
          return Response.json({ error: "id must be a positive integer" }, { status: 400 })
        console.log(`[INFO][${stage}] Deleting conversation: id=${convId}`)
        const result = await stub.deleteConversation(convId)
        return Response.json(result)
      }

      // Effective TypeScript — Item 68: Use TSDoc for API Comments
      // These in-body route docs are the API reference — in .ts they become TSDoc on typed handlers, and "@returns {Promise<Object>}" fuzz becomes real types (Item 31: no type info in docs).

      /**
       * POST /update-summaries - Manually triggers an update of all summaries.
       * @returns {Promise<Object>} Success status
       */
      if (request.method === "POST" && url.pathname === "/update-summaries") {
        console.log(`[INFO][${stage}] Manual summary update triggered`)
        await stub.updateAllSummaries()
        console.log(`[INFO][${stage}] Manual summary update completed`)
        return Response.json({ success: true })
      }

      // Effective TypeScript — Item 22: Understand Type Narrowing
      // The four-way guard narrows the parsed-any body before stub.updateSummary — in TS a discriminated request union (UpdateSummaryRequest) would replace it.
      // Item 29: Prefer Types That Always Represent Valid States — parse+validate once into a valid-state type instead of re-checking fields at each use.

      /**
       * POST /update-summary - Updates a specific category or topic summary.
       * @returns {Promise<Object>} Update result
       */
      if (request.method === "POST" && url.pathname === "/update-summary") {
        let body: { type: string; id: number; summary: string } | unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 })
        }
        if (!("id" in body || "summary" in body || typeof body.id !== "number" || typeof body.summary !== "string")) {
          return Response.json({ error: "type, id, and summary are required" }, { status: 400 })
        }
        if (
          !["category", "topic"].includes(body?.type) ||
          typeof body?.id !== "number" ||
          typeof body?.summary !== "string"
        )
          return Response.json({ error: "type, id, and summary are required" }, { status: 400 })

        const result = await stub.updateSummary(body.type, body.id, body.summary)
        return Response.json(result)
      }

      return Response.json({ error: "Not found" }, { status: 404 })
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] ${err.message}`)
      }
      return Response.json({ error: "Internal server error" }, { status: 500 })
    }
  },
}
