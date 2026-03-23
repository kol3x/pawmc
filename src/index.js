import { DurableObject } from "cloudflare:workers";

/**
 * Cloudflare Worker that uses SQLite-backed Durable Object. Works as a personal LLM assistant. It stores conversations and can uses summed up context when generating responses.
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
 * @class AssistantDurableObject
 * @augments {DurableObject}
 * @property {DurableObjectState} state
 * @property {WorkerEnvironment} env
 *
 * ## SQLite Schema (Durable Object Storage)
 * ```sql
 * CREATE TABLE IF NOT EXISTS categories (
 *   id INTEGER PRIMARY KEY AUTOINCREMENT,
 *   name TEXT NOT NULL UNIQUE,
 *   summary TEXT NOT NULL DEFAULT '',
 *   updated_at_timestamp INTEGER DEFAULT (strftime('%s', 'now'))
 * );
 * 
 * CREATE TABLE IF NOT EXISTS topics (
 *   id INTEGER PRIMARY KEY AUTOINCREMENT,
 *   category_id INTEGER NOT NULL,
 *   name TEXT NOT NULL,
 *   summary TEXT NOT NULL DEFAULT '',
 *   updated_at_timestamp INTEGER DEFAULT (strftime('%s', 'now')),
 *   UNIQUE(category_id, name),
 *   FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
 * );
 * 
 * CREATE TABLE IF NOT EXISTS conversations (
 *   id INTEGER PRIMARY KEY AUTOINCREMENT,
 *   topic_id INTEGER NOT NULL,
 *   messages TEXT NOT NULL DEFAULT '[]',
 *   created_at_timestamp INTEGER DEFAULT (strftime('%s', 'now')),
 *   FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
 * );
 * ```
 */
export class AssistantDurableObject extends DurableObject {
  #db;

  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.#db = state.storage.sql;
    this.initSchema();
  }

  async initSchema() {
    await this.#db.exec(`
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
        created_at_timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
      );
    `);
  }

  /**
   * Processes a user message within a specified category and topic, generates an AI response using the stored conversation history and summary context, and updates the conversation. If the category or topic doesn't exist, it will be created.
   * @param {string} category
   * @param {string} topic
   * @param {string} userMessage
   * @returns {Promise<{response: string, conversationId: number}>}
   */
  async chat(category, topic, userMessage) {
    const stage = "chat";
    try {
      if (!category?.trim() || !topic?.trim() || !userMessage?.trim())
        throw new Error(`[${stage}] Invalid input: category, topic, and userMessage are required`);

      const categoryRow = this.#db.exec(
        `INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id`,
        category.trim()
      ).one();
      console.log(`[INFO][${stage}] Category resolved: id=${categoryRow.id}, name=${category}`);

      const topicRow = this.#db.exec(
        `INSERT INTO topics (category_id, name) VALUES (?, ?) ON CONFLICT(category_id, name) DO UPDATE SET name=name RETURNING id, summary`,
        categoryRow.id, topic.trim()
      ).one();
      console.log(`[INFO][${stage}] Topic resolved: id=${topicRow.id}, name=${topic}`);

      const existingConversation = this.#db.exec(
        `SELECT id, messages FROM conversations WHERE topic_id = ? ORDER BY created_at_timestamp DESC LIMIT 1`,
        topicRow.id
      ).one();

      let conversationId;
      let messages = [];

      if (existingConversation) {
        conversationId = existingConversation.id;
        try { messages = JSON.parse(existingConversation.messages); } catch {
          console.error(`[ERROR][${stage}] Failed to parse messages for conversation=${conversationId}`);
          messages = [];
        }
      } else {
        const newConversation = this.#db.exec(
          `INSERT INTO conversations (topic_id, messages) VALUES (?, '[]') RETURNING id`,
          topicRow.id
        ).one();
        conversationId = newConversation.id;
        console.log(`[INFO][${stage}] New conversation created: id=${conversationId}`);
      }

      messages.push({ role: "user", content: userMessage });

      const systemPrompt = [
        `You are a personal assistant helping with: ${category} / ${topic}.`,
        topicRow.summary ? `Context summary: ${topicRow.summary}` : null
      ].filter(Boolean).join("\n");

      const aiResponse = await this.env.AI.run("@cf/zai-org/glm-4.7-flash", {
        messages: [
          { role: "system", content: systemPrompt },
          ...messages
        ]
      });

      const assistantMessage = aiResponse?.response;
      if (!assistantMessage) throw new Error(`[${stage}] AI returned empty response`);

      messages.push({ role: "assistant", content: assistantMessage });

      this.#db.exec(
        `UPDATE conversations SET messages = ? WHERE id = ?`,
        JSON.stringify(messages), conversationId
      );
      console.log(`[INFO][${stage}] Conversation updated: id=${conversationId}, messages=${messages.length}`);

      return { response: assistantMessage, conversationId };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  /**
   * Returns all categories and topics. Meant for listing available contexts and their summaries.
   */
  async getCategories() {
    const stage = "getCategories";
    try {
      const categories = [...this.#db.exec(`SELECT id, name, summary, updated_at_timestamp FROM categories ORDER BY name`).toArray()];
      const result = categories.map(cat => {
        const topics = [...this.#db.exec(
          `SELECT id, name, summary, updated_at_timestamp FROM topics WHERE category_id = ? ORDER BY name`,
          cat.id
        ).toArray()];
        return { ...cat, topics };
      });
      console.log(`[INFO][${stage}] Fetched ${result.length} categories`);
      return result;
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }
  /**
   * Processes unsummarized conversations and updates summaries. Meant to run daily or on demand.
   * @returns {Promise<void>}
   */
  async updateSummaries() {
    const stage = "updateSummaries";
    try {
      const topics = [...this.#db.exec(
        `SELECT t.id, t.name, t.summary, c.name as category_name
         FROM topics t
         JOIN categories c ON c.id = t.category_id`
      ).toArray()];

      for (const topic of topics) {
        try {
          const conversations = [...this.#db.exec(
            `SELECT id, messages FROM conversations WHERE topic_id = ? ORDER BY created_at_timestamp ASC`,
            topic.id
          ).toArray()];

          if (!conversations.length) continue;

          const allMessages = conversations.flatMap(conv => {
            try { return JSON.parse(conv.messages); } catch {
              console.error(`[ERROR][${stage}] Failed to parse messages for conversation=${conv.id}`);
              return [];
            }
          });

          if (!allMessages.length) continue;

          const summaryPrompt = [
            topic.summary ? `Existing summary: ${topic.summary}` : null,
            `Summarize the following conversation history for context retention. Be concise and focus on key information, decisions, and facts. Category: ${topic.category_name}, Topic: ${topic.name}.`
          ].filter(Boolean).join("\n");

          const aiResponse = await this.env.AI.run("@cf/zai-org/glm-4.7-flash", {
            messages: [
              { role: "system", content: summaryPrompt },
              { role: "user", content: JSON.stringify(allMessages) }
            ]
          });

          const newSummary = aiResponse?.response;
          if (!newSummary) throw new Error(`[${stage}] AI returned empty summary for topic=${topic.id}`);

          this.#db.exec(
            `UPDATE topics SET summary = ?, updated_at_timestamp = strftime('%s', 'now') WHERE id = ?`,
            newSummary, topic.id
          );
          console.log(`[INFO][${stage}] Summary updated: topic=${topic.id}, name=${topic.name}`);
        } catch (err) {
          console.error(`[ERROR][${stage}] Failed to update summary for topic=${topic.id}: ${err.message}`);
        }
      }
      console.log(`[INFO][${stage}] Summary update complete: processed ${topics.length} topics`);
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }
}

/**
 * @exports default
 * Cloudflare Worker handler for scheduled (cron) events and HTTP requests. 
 * 
 * On each scheduled run, gets a singleton instance of the `ASSISTANT_DO` and updates summaries by processing unsummarized conversations. On HTTP request, routes to the appropriate method of the `AssistantDurableObject` based on the request path and method.
 * 
 */
export default {
  async scheduled(event, env, ctx) {
    const stage = "scheduled";
    try {
      const id = env.ASSISTANT_DO.idFromName("singleton");
      const stub = env.ASSISTANT_DO.get(id);
      await stub.updateSummaries();
      console.log(`[INFO][${stage}] Scheduled summary update complete`);
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  },

  /**
   * @param {Request} request
   * @param {WorkerEnvironment} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const stage = "fetch";
    try {
      const url = new URL(request.url);
      const id = env.ASSISTANT_DO.idFromName("singleton");
      const stub = env.ASSISTANT_DO.get(id);

      if (request.method === "POST" && url.pathname === "/chat") {
        let body;
        try { body = await request.json(); } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const { category, topic, message } = body ?? {};
        if (!category?.trim() || !topic?.trim() || !message?.trim())
          return Response.json({ error: "category, topic, and message are required" }, { status: 400 });

        console.log(`[INFO][${stage}] Chat request: category=${category}, topic=${topic}`);
        const result = await stub.chat(category, topic, message);
        return Response.json(result);
      }

      if (request.method === "GET" && url.pathname === "/categories") {
        console.log(`[INFO][${stage}] Fetching categories`);
        const categories = await stub.getCategories();
        return Response.json(categories);
      }

      if (request.method === "POST" && url.pathname === "/update-summaries") {
        console.log(`[INFO][${stage}] Manual summary update triggered`);
        await stub.updateSummaries();
        return Response.json({ success: true });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  }
};
