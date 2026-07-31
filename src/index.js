import { DurableObject } from "cloudflare:workers";

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
 * - Stick to JSDoc for specifications, documentation, and type definitions.
 * - Robust error handling and logging techniques with succinct messages. Wrapping each data processing stage in a try-catch block, validating all inputs and outputs, and using `INFO` and `ERROR` levels with detailed contextual information, such as processing stage, task name, etc.
 * - Concise code with minimal formatting and indentation, which prioritizes descriptive element naming and log messages over inline comments to achieve readability.
 */

/**
 * @param {unknown} err
 * @returns {err is Error}
 */
function isError(err) {
  return err instanceof Error;
}


/**
 * @class AssistantDurableObject
 * @augments DurableObject
 * @property {DurableObjectState} state
 * @property {WorkerEnvironment} env
 */
export class AssistantDurableObject extends DurableObject {
  #db

  /**
   * Runs the AI model with the given system prompt and user messages.
   * @param {string} systemPrompt
   * @param {Array<{ role: string, content: string }> | string} userContentOrMessages
   * @returns {Promise<string>}
   */
  async #runAI(systemPrompt, userContentOrMessages) {
    const conversation = Array.isArray(userContentOrMessages)
      ? userContentOrMessages
      : [{ role: "user", content: userContentOrMessages }]
    const messages = [{ role: "system", content: systemPrompt }, ...conversation]

    const provider = this.env.AI_PROVIDER || "workers-ai"
    const res =
      provider === "openrouter"
        ? await this.#callOpenRouter(messages)
        : await this.env.AI.run(this.env.AI_MODEL_WORKERS_AI, { messages })

    const content = res?.choices?.[0]?.message?.content
    if (!content && typeof res === "string") return res
    if (!content) throw new Error("AI returned empty response")
    return content
  }

  /**
   * Calls the OpenRouter API with the provided messages.
   * @param {Array<{ role: string, content: string }>} messages
   * @returns {Promise<any>}
   */
  async #callOpenRouter(messages) {
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
   * @param {Array<{ id: number, messages: string }>} conversations
   * @returns {Array<{ role: string, content: string }>}
   */
  #parseMessages(conversations) {
    return conversations.flatMap((conv) => {
      try {
        return JSON.parse(conv.messages)
      } catch {
        console.error(`[ERROR] Failed to parse messages for conversation=${conv.id}`)
        return []
      }
    })
  }
  /**
   *
   * @param {DurableObjectState} state
   * @param {Env} env
   */
  constructor(state, env) {
    super(state, env)
    this.state = state
    this.env = env
    this.#db = state.storage.sql
    this.initSchema()
  }

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
      this.#db.exec(
        `ALTER TABLE categories ADD COLUMN updated_at_timestamp INTEGER DEFAULT (strftime('%s', 'now'))`,
      )
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
   * Processes a user message within a specified category and topic, generates an AI response using the stored conversation history and summary context, and updates the conversation. If the category or topic doesn't exist, it will be created.
   *
   * Reuses the topic's latest conversation only if it was created at or after the topic's last
   * summary update (i.e. it hasn't been folded into the summary yet). Otherwise, since the
   * existing conversation is considered already summarized, a new conversation is started.
   * @param {string} category
   * @param {string} topic
   * @param {string} userMessage
   * @param {boolean} [noteMode] - If true, skips full AI response and just acknowledges
   * @param {Array<{category: string, topic?: string}>} [contextCategories] - Additional categories/topics to pull context from
   * @returns {Promise<{response: string, conversationId: number} | undefined>}
   */
  async chat(category, topic, userMessage, noteMode = false, contextCategories = []) {
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
      let messages = []

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
          .exec(
            `INSERT INTO conversations (topic_id, messages, context_categories) VALUES (?, '[]', ?) RETURNING id`,
            topicRow.id,
            JSON.stringify(contextCategories),
          )
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
        `UPDATE conversations SET messages = ?, last_message = ?, context_categories = ? WHERE id = ?`,
        JSON.stringify(messages),
        lastMsg,
        JSON.stringify(contextCategories),
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

  /**
   * Incrementally updates a topic's summary by processing only new conversations since the last summary update.
   * @param {number} topicId
   * @returns {Promise<void>}
   */
  async updateTopicSummaryIncremental(topicId) {
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

      const newSummary = await this.#runAI(summaryPrompt, JSON.stringify(newMessages))

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

  /**
   * Incrementally updates a category's summary by processing only topics that have been updated since the last category summary update.
   * @param {number} categoryId
   * @returns {Promise<void>}
   */
  async updateCategorySummaryIncremental(categoryId) {
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

      const newSummary = await this.#runAI(summaryPrompt, "Generate the updated category summary.")

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
   * @param {"category"|"topic"} type
   * @param {number} id
   * @param {string} summary - new summary text, or empty string to clear
   * @returns {{success: boolean}}
   */
  updateSummary(type, id, summary) {
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
        await this.updateTopicSummaryIncremental(Number(topic.id))
      }

      const categories = [...this.#db.exec(`SELECT id FROM categories`).toArray()]
      for (const category of categories) {
        await this.updateCategorySummaryIncremental(Number(category.id))
      }

      console.log(`[INFO][${stage}] All summaries updated successfully`)
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] ${err.message}`)
        throw err
      }
    }
  }

  /**
   * Returns all conversations with category, topic, timestamp, and last message preview, ordered by most recent.
   * @param {string} category - optional category filter
   * @param {string} topic - optional topic filter
   * @returns {Promise<Array<{id: number, category: string, topic: string, created_at: number, last_message: string, contextCategories: Array<string>}> | undefined>}
   */
  async listConversations(category, topic) {
    const stage = "listConversations"
    try {
      let sql = `
        SELECT c.id, c.created_at_timestamp, c.last_message, c.context_categories, cat.name as category, t.name as topic
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
        let contextCategories = []
        if (typeof r.context_categories === "string") {
          contextCategories = JSON.parse(r.context_categories || "[]")
        }
        return {
          id: Number(r.id),
          category: String(r.category),
          topic: String(r.topic),
          created_at: Number(r.created_at_timestamp),
          last_message: (String(r.last_message) || "").slice(0, 80),
          contextCategories,
        }
      })
      console.log(`[INFO][${stage}] Listed ${result.length} conversations`)
      return result
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] ${err.message}`)
        throw err
      }
    }
  }

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

  /**
   * Returns a single conversation with its messages.
   * @param {number} id
   * @returns {Promise<{id: number, category: string, topic: string, messages: Array<{role: string, content: string}>} | undefined>}
   */
  async getConversation(id) {
    const stage = "getConversation"
    try {
      const row = this.#db
        .exec(
          `
        SELECT c.id, c.messages, c.context_categories, cat.name as category, t.name as topic
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
      let contextCategories = []
      try {
        contextCategories = JSON.parse(row.context_categories || "[]")
      } catch {}
      console.log(`[INFO][${stage}] Fetched conversation: id=${id}, messages=${messages.length}`)
      return { id: Number(row.id), category: String(row.category), topic: String(row.topic), messages, contextCategories }
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] ${err.message}`)
        throw err
      }
    }
  }

  /**
   * Stores messages as a new conversation in the given category/topic without calling AI.
   * Creates the category and topic if they don't exist.
   * @param {string} category
   * @param {string} topic
   * @param {Array<{role: string, content: string}>} messages
   * @returns {Promise<{conversationId: number} | undefined>}
   */
  async storeConversationMessage(category, topic, messages) {
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

/**
 * @exports default
 * Cloudflare Worker handler for scheduled (cron) events and HTTP requests.
 */
export default {
  /**
   * On each scheduled run, gets a singleton instance of the `ASSISTANT_DO` and updates summaries by processing unsummarized conversations. On HTTP request, routes to the appropriate method of the `AssistantDurableObject` based on the request path and method.
   * @param {ScheduledController} event 
   * @param {Env} env 
   * @param {ExecutionContext} ctx 
   */
  async scheduled(event, env, ctx) {
    const stage = "scheduled";
    try {
      const id = env.ASSISTANT_DO.idFromName("singleton");
      const stub = env.ASSISTANT_DO.get(id);
      await stub.updateAllSummaries();
      console.log(`[INFO][${stage}] Scheduled summary update complete`);
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] ${err.message}`);
        throw err;
      }
    }
  },
  /**
   * HTTP request handler that routes requests to chat, category, conversation, and summary management endpoints. Validates API key authorization and processes GET, POST, and DELETE methods.
   * @param {Request} request 
   * @param {Env} env 
   * @param {ExecutionContext} ctx 
   */
  async fetch(request, env, ctx) {
    const stage = "fetch";
    try {
      const url = new URL(request.url);
      const id = env.ASSISTANT_DO.idFromName("singleton");
      const stub = env.ASSISTANT_DO.get(id);

      const authHeader = request.headers.get("Authorization");
      const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!apiKey || apiKey !== env.API_KEY || !env.API_KEY) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      /**
       * POST /chat - Sends a message to the AI assistant and returns a response with optional context from other topics.
       * @param {string} category - The category of the topic
       * @param {string} topic - The topic to chat about
       * @param {string} message - The message to send to the AI
       * @param {boolean} [noteMode] - Whether to enable note mode
       * @param {string[]} [contextCategories] - Optional categories to include for context
       * @returns {Promise<Object>} Chat response from the AI assistant
       */
      if (request.method === "POST" && url.pathname === "/chat") {
        let body;
        try { body = await request.json(); } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const { category, topic, message, noteMode, contextCategories: rawContextCategories } = body ?? {};
        const contextCategories = Array.isArray(rawContextCategories) ? rawContextCategories : [];
        if (!category?.trim() || !topic?.trim() || !message?.trim())
          return Response.json({ error: "category, topic, and message are required" }, { status: 400 });

        console.log(`[INFO][${stage}] Chat request: category=${category}, topic=${topic}, contextCategories=${JSON.stringify(contextCategories)}, noteMode=${!!noteMode}`);
        const result = await stub.chat(category, topic, message, !!noteMode, contextCategories);
        return Response.json(result);
      }

      /**
       * GET /categories - Retrieves all available categories.
       * @returns {Promise<Array>} List of all categories
       */
      if (request.method === "GET" && url.pathname === "/categories") {
        console.log(`[INFO][${stage}] Fetching categories`);
        const categories = await stub.getCategories();
        return Response.json(categories);
      }

      /**
       * GET /conversations - Lists conversations, optionally filtered by category and/or topic.
       * @param {string} [category] - Optional category to filter by
       * @param {string} [topic] - Optional topic to filter by
       * @returns {Promise<Array>} List of conversations
       */
      if (request.method === "GET" && url.pathname === "/conversations") {
        const category = url.searchParams.get("category") || "";
        const topic = url.searchParams.get("topic") || "";
        console.log(`[INFO][${stage}] Listing conversations${category ? ` category=${category}` : ""}${topic ? ` topic=${topic}` : ""}`);
        const result = await stub.listConversations(category, topic);
        return Response.json(result);
      }

      /**
       * GET /conversation - Retrieves a single conversation by ID.
       * @param {number} id - The conversation ID (positive integer, required)
       * @returns {Promise<Object>} Conversation details
       */
      if (request.method === "GET" && url.pathname === "/conversation") {
        const id = url.searchParams.get("id");
        if (!id) return Response.json({ error: "id query parameter is required" }, { status: 400 });
        const convId = Number(id);
        if (!Number.isInteger(convId) || convId <= 0)
          return Response.json({ error: "id must be a positive integer" }, { status: 400 });
        console.log(`[INFO][${stage}] Fetching conversation: id=${convId}`);
        const result = await stub.getConversation(convId);
        return Response.json(result);
      }

      /**
       * DELETE /conversation - Deletes a conversation by ID.
       * @param {number} id - The conversation ID (positive integer, required)
       * @returns {Promise<Object>} Deletion result
       */
      if (request.method === "DELETE" && url.pathname === "/conversation") {
        const id = url.searchParams.get("id");
        if (!id) return Response.json({ error: "id query parameter is required" }, { status: 400 });
        const convId = Number(id);
        if (!Number.isInteger(convId) || convId <= 0)
          return Response.json({ error: "id must be a positive integer" }, { status: 400 });
        console.log(`[INFO][${stage}] Deleting conversation: id=${convId}`);
        const result = await stub.deleteConversation(convId);
        return Response.json(result);
      }

      /**
       * POST /update-summaries - Manually triggers an update of all summaries.
       * @returns {Promise<Object>} Success status
       */
      if (request.method === "POST" && url.pathname === "/update-summaries") {
        console.log(`[INFO][${stage}] Manual summary update triggered`);
        await stub.updateAllSummaries();
        console.log(`[INFO][${stage}] Manual summary update completed`);
        return Response.json({ success: true });
      }

      /**
       * POST /update-summary - Updates a specific category or topic summary.
       * @param {string} type - The type to update: 'category' or 'topic' (required)
       * @param {number} id - The ID of the category or topic (required)
       * @param {string} summary - The new summary text (required)
       * @returns {Promise<Object>} Update result
       */
      if (request.method === "POST" && url.pathname === "/update-summary") {
        let body;
        try { body = await request.json(); } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        if (!["category", "topic"].includes(body?.type) || typeof body?.id !== "number" || typeof body?.summary !== "string")
          return Response.json({ error: "type, id, and summary are required" }, { status: 400 });

        const result = await stub.updateSummary(body.type, body.id, body.summary);
        return Response.json(result);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err) {
      if (isError(err)) {
        console.error(`[ERROR][${stage}] ${err.message}`);
      }
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  }
};
