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
 */
export class AssistantDurableObject extends DurableObject {
  #db;

  #runAI(systemPrompt, userContent) {
    return this.env.AI.run(this.env.AI_MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ]
    }).then(res => {
      const content = res?.choices?.[0]?.message?.content;
      if (!content && typeof res === "string") return res;
      if (!content) throw new Error("AI returned empty response");
      return content;
    });
  }

  #parseMessages(conversations) {
    return conversations.flatMap(conv => {
      try { return JSON.parse(conv.messages); } catch {
        console.error(`[ERROR] Failed to parse messages for conversation=${conv.id}`);
        return [];
      }
    });
  }

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

    const categoryColumns = this.#db.exec(`PRAGMA table_info(categories)`).toArray();
    const hasUpdatedAtTimestamp = categoryColumns.some(col => col.name === 'updated_at_timestamp');
    if (!hasUpdatedAtTimestamp) {
      await this.#db.exec(`ALTER TABLE categories ADD COLUMN updated_at_timestamp INTEGER DEFAULT (strftime('%s', 'now'))`);
    }

    const topicColumns = this.#db.exec(`PRAGMA table_info(topics)`).toArray();
    const hasUpdatedAtTimestampTopics = topicColumns.some(col => col.name === 'updated_at_timestamp');
    if (!hasUpdatedAtTimestampTopics) {
      await this.#db.exec(`ALTER TABLE topics ADD COLUMN updated_at_timestamp INTEGER DEFAULT (strftime('%s', 'now'))`);
    }
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

      const [existingConversation] = this.#db.exec(
        `SELECT id, messages FROM conversations WHERE topic_id = ? ORDER BY created_at_timestamp DESC LIMIT 1`,
        topicRow.id
      ).toArray();

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
        this.env.AI_SYSTEM_INSTRUCTION,
        `You are a personal assistant helping with: ${category} / ${topic}.`,
        topicRow.summary ? `Context summary: ${topicRow.summary}` : null
      ].filter(Boolean).join("\n");

      const aiResponse = await this.env.AI.run(this.env.AI_MODEL, {
        messages: [
          { role: "system", content: systemPrompt },
          ...messages
        ]
      });

      console.log(`[DEBUG][${stage}] AI response:`, JSON.stringify(aiResponse));

      let assistantMessage = aiResponse?.choices?.[0]?.message?.content;
      if (!assistantMessage && typeof aiResponse === "string") {
        assistantMessage = aiResponse;
      }
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
   * Queries all topics with a custom prompt. Iterates through every topic,
   * aggregates its conversation messages, and sends them with the custom prompt to AI.
   * @param {string} prompt
   * @returns {Promise<Array<{topicId: number, topicName: string, response: string}>>}
   */
  async queryTopic(prompt) {
    const stage = "queryTopic";
    const results = [];
    try {
      const topics = [...this.#db.exec(
        `SELECT t.id, t.name, t.summary, c.name as category_name
         FROM topics t
         JOIN categories c ON c.id = t.category_id`
      ).toArray()];

      console.log(`[INFO][${stage}] Processing ${topics.length} topics`);

      for (const topic of topics) {
        try {
          const conversations = [...this.#db.exec(
            `SELECT id, messages FROM conversations WHERE topic_id = ? ORDER BY created_at_timestamp ASC`,
            topic.id
          ).toArray()];

          if (!conversations.length) {
            console.log(`[INFO][${stage}] Skipping topic=${topic.id}: no conversations`);
            continue;
          }

          const allMessages = this.#parseMessages(conversations);

          if (!allMessages.length) {
            console.log(`[INFO][${stage}] Skipping topic=${topic.id}: no messages`);
            continue;
          }

          const systemPrompt = [
            this.env.AI_SYSTEM_INSTRUCTION,
            `Category: ${topic.category_name}, Topic: ${topic.name}.`,
            prompt
          ].join("\n");

          console.log(`[INFO][${stage}] Querying topic: id=${topic.id}, name=${topic.name}`);

          const response = await this.#runAI(systemPrompt, JSON.stringify(allMessages));

          results.push({ topicId: topic.id, topicName: topic.name, response });
        } catch (err) {
          console.error(`[ERROR][${stage}] Failed to query topic=${topic.id}: ${err.message}`);
        }
      }
      console.log(`[INFO][${stage}] Query complete: processed ${topics.length} topics`);
      return results;
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  /**
   * Queries all categories with a custom prompt. Iterates through every category,
   * collects topic summaries, and sends them with the custom prompt to AI.
   * @param {string} prompt
   * @returns {Promise<Array<{categoryId: number, categoryName: string, response: string}>>}
   */
  async queryCategory(prompt) {
    const stage = "queryCategory";
    const results = [];
    try {
      const categories = [...this.#db.exec(
        `SELECT c.id, c.name, c.summary
         FROM categories c`
      ).toArray()];

      console.log(`[INFO][${stage}] Processing ${categories.length} categories`);

      for (const category of categories) {
        try {
          const topicsWithSummaries = [...this.#db.exec(
            `SELECT t.id, t.name, t.summary
             FROM topics t
             WHERE t.category_id = ? AND t.summary != ''`,
            category.id
          ).toArray()];

          if (!topicsWithSummaries.length) {
            console.log(`[INFO][${stage}] Skipping category=${category.id}: no topics with summaries`);
            continue;
          }

          const topicSummariesText = topicsWithSummaries
            .map(t => `- ${t.name}: ${t.summary}`)
            .join("\n\n");

          const systemPrompt = [
            this.env.AI_SYSTEM_INSTRUCTION,
            `Category: ${category.name}.`,
            prompt,
            `Topic summaries:\n${topicSummariesText}`
          ].join("\n\n");

          console.log(`[INFO][${stage}] Querying category: id=${category.id}, name=${category.name}, topics=${topicsWithSummaries.length}`);

          const response = await this.#runAI(systemPrompt, "Process the query.");

          results.push({ categoryId: category.id, categoryName: category.name, response });
        } catch (err) {
          console.error(`[ERROR][${stage}] Failed to query category=${category.id}: ${err.message}`);
        }
      }
      console.log(`[INFO][${stage}] Query complete: processed ${categories.length} categories`);
      return results;
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  /**
   * Incrementally updates a topic's summary by processing only new conversations since the last summary update.
   * @param {number} topicId
   * @returns {Promise<void>}
   */
  async updateTopicSummaryIncremental(topicId) {
    const stage = "updateTopicSummaryIncremental";
    try {
      const topic = this.#db.exec(
        `SELECT t.id, t.name, t.summary, t.updated_at_timestamp, c.name as category_name
         FROM topics t
         JOIN categories c ON c.id = t.category_id
         WHERE t.id = ?`,
        topicId
      ).one();

      if (!topic) throw new Error(`[${stage}] Topic not found: ${topicId}`);

      const lastSummaryAt = topic.updated_at_timestamp || 0;
      const conversations = [...this.#db.exec(
        `SELECT id, messages FROM conversations
         WHERE topic_id = ? AND created_at_timestamp > ?
         ORDER BY created_at_timestamp ASC`,
        topicId, lastSummaryAt
      ).toArray()];

      if (!conversations.length) {
        console.log(`[INFO][${stage}] No new conversations for topic=${topicId}`);
        return;
      }

      const newMessages = this.#parseMessages(conversations);

      if (!newMessages.length) {
        console.log(`[INFO][${stage}] No new messages for topic=${topicId}`);
        return;
      }

      const summaryPrompt = [
        this.env.AI_SYSTEM_INSTRUCTION,
        topic.summary ? `Existing summary: ${topic.summary}` : null,
        `Update the summary by incorporating the following NEW messages. Keep it concise and focus on key information, decisions, and facts. Category: ${topic.category_name}, Topic: ${topic.name}.`
      ].filter(Boolean).join("\n");

      console.log(`[INFO][${stage}] Updating topic summary: id=${topic.id}, name=${topic.name}, newMessages=${newMessages.length}`);

      const newSummary = await this.#runAI(summaryPrompt, JSON.stringify(newMessages));

      this.#db.exec(
        `UPDATE topics SET summary = ?, updated_at_timestamp = strftime('%s', 'now') WHERE id = ?`,
        newSummary, topic.id
      );
      console.log(`[INFO][${stage}] Topic summary updated: topic=${topic.id}, name=${topic.name}`);
    } catch (err) {
      console.error(`[ERROR][${stage}] Failed to update topic summary: ${err.message}`);
      throw err;
    }
  }

  /**
   * Incrementally updates a category's summary by processing only topics that have been updated since the last category summary update.
   * @param {number} categoryId
   * @returns {Promise<void>}
   */
  async updateCategorySummaryIncremental(categoryId) {
    const stage = "updateCategorySummaryIncremental";
    try {
      const category = this.#db.exec(
        `SELECT id, name, summary, updated_at_timestamp FROM categories WHERE id = ?`,
        categoryId
      ).one();

      if (!category) throw new Error(`[${stage}] Category not found: ${categoryId}`);

      const lastCatSummaryAt = category.updated_at_timestamp || 0;
      const updatedTopics = [...this.#db.exec(
        `SELECT id, name, summary
         FROM topics
         WHERE category_id = ? AND summary != '' AND updated_at_timestamp > ?`,
        categoryId, lastCatSummaryAt
      ).toArray()];

      if (!updatedTopics.length) {
        console.log(`[INFO][${stage}] No updated topics for category=${categoryId}`);
        return;
      }

      const topicSummariesText = updatedTopics
        .map(t => `- ${t.name}: ${t.summary}`)
        .join("\n\n");

      const summaryPrompt = [
        this.env.AI_SYSTEM_INSTRUCTION,
        category.summary ? `Existing category summary: ${category.summary}` : null,
        `Update the category summary by incorporating the following UPDATED topic summaries. The category summary should provide a high-level overview, highlighting common themes and key areas of focus.`,
        `Updated topic summaries:\n${topicSummariesText}`
      ].filter(Boolean).join("\n\n");

      console.log(`[INFO][${stage}] Updating category summary: id=${category.id}, name=${category.name}, updatedTopics=${updatedTopics.length}`);

      const newSummary = await this.#runAI(summaryPrompt, "Generate the updated category summary.");

      this.#db.exec(
        `UPDATE categories SET summary = ?, updated_at_timestamp = strftime('%s', 'now') WHERE id = ?`,
        newSummary, category.id
      );
      console.log(`[INFO][${stage}] Category summary updated: category=${category.id}, name=${category.name}`);
    } catch (err) {
      console.error(`[ERROR][${stage}] Failed to update category summary: ${err.message}`);
      throw err;
    }
  }

  /**
   * Updates all summaries incrementally. Iterates through all topics and categories,
   * processing only new conversations since last summary update.
   * @returns {Promise<void>}
   */
  async updateAllSummaries() {
    const stage = "updateAllSummaries";
    try {
      const topics = [...this.#db.exec(`SELECT id FROM topics`).toArray()];
      for (const topic of topics) {
        await this.updateTopicSummaryIncremental(topic.id);
      }

      const categories = [...this.#db.exec(`SELECT id FROM categories`).toArray()];
      for (const category of categories) {
        await this.updateCategorySummaryIncremental(category.id);
      }

      console.log(`[INFO][${stage}] All summaries updated successfully`);
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  /**
   * Queries a specific topic by name with a custom prompt.
   * @param {string} categoryName
   * @param {string} topicName
   * @param {string} prompt
   * @returns {Promise<{response: string}>}
   */
  async queryTopicByName(categoryName, topicName, prompt) {
    const stage = "queryTopicByName";
    try {
      const categoryRow = this.#db.exec(`SELECT id FROM categories WHERE name = ?`, categoryName.trim()).one();
      if (!categoryRow) throw new Error(`Category not found: ${categoryName}`);

      const topicRow = this.#db.exec(
        `SELECT id, name FROM topics WHERE category_id = ? AND name = ?`,
        categoryRow.id, topicName.trim()
      ).one();
      if (!topicRow) throw new Error(`Topic not found: ${topicName}`);

      const conversations = [...this.#db.exec(
        `SELECT id, messages FROM conversations WHERE topic_id = ? ORDER BY created_at_timestamp ASC`,
        topicRow.id
      ).toArray()];

      if (!conversations.length) throw new Error("No conversations found");

      const allMessages = this.#parseMessages(conversations);
      if (!allMessages.length) throw new Error("No messages found");

      const systemPrompt = [this.env.AI_SYSTEM_INSTRUCTION, `Category: ${categoryName}, Topic: ${topicName}.`, prompt].join("\n");
      const response = await this.#runAI(systemPrompt, JSON.stringify(allMessages));

      return { response };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  /**
   * Queries a specific category by name with a custom prompt.
   * @param {string} categoryName
   * @param {string} prompt
   * @returns {Promise<{response: string}>}
   */
  async queryCategoryByName(categoryName, prompt) {
    const stage = "queryCategoryByName";
    try {
      const categoryRow = this.#db.exec(`SELECT id, name FROM categories WHERE name = ?`, categoryName.trim()).one();
      if (!categoryRow) throw new Error(`Category not found: ${categoryName}`);

      const topics = [...this.#db.exec(
        `SELECT id, name, summary FROM topics WHERE category_id = ? AND summary != ''`,
        categoryRow.id
      ).toArray()];

      if (!topics.length) throw new Error("No topics with summaries found");

      const topicSummariesText = topics.map(t => `- ${t.name}: ${t.summary}`).join("\n\n");

      const systemPrompt = [this.env.AI_SYSTEM_INSTRUCTION, `Category: ${categoryRow.name}.`, prompt, `Topic summaries:\n${topicSummariesText}`].join("\n");
      const response = await this.#runAI(systemPrompt, "Process the query.");

      return { response };
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
      await stub.updateAllSummaries();
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

      const authHeader = request.headers.get("Authorization");
      const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!apiKey || apiKey !== env.API_KEY) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

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
        await stub.updateAllSummaries();
        console.log(`[INFO][${stage}] Manual summary update completed`);
        return Response.json({ success: true });
      }

      if (request.method === "POST" && url.pathname === "/query-topic") {
        let body;
        try { body = await request.json(); } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const { category, topic, prompt } = body ?? {};
        if (!category?.trim() || !topic?.trim() || !prompt?.trim())
          return Response.json({ error: "category, topic, and prompt are required" }, { status: 400 });

        console.log(`[INFO][${stage}] Query topic: category=${category}, topic=${topic}`);
        const result = await stub.queryTopicByName(category, topic, prompt);
        return Response.json({ category, topic, prompt, response: result.response });
      }

      if (request.method === "POST" && url.pathname === "/query-category") {
        let body;
        try { body = await request.json(); } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const { category, prompt } = body ?? {};
        if (!category?.trim() || !prompt?.trim())
          return Response.json({ error: "category and prompt are required" }, { status: 400 });

        console.log(`[INFO][${stage}] Query category: category=${category}`);
        const result = await stub.queryCategoryByName(category, prompt);
        return Response.json({ category, prompt, response: result.response });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  }
};
