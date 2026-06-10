import { DurableObject } from "cloudflare:workers";
import { resolve as resolveContexts, list as listContextSources } from "./context.js";

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
        last_message TEXT NOT NULL DEFAULT '',
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

    const convColumns = this.#db.exec(`PRAGMA table_info(conversations)`).toArray();
    if (!convColumns.some(col => col.name === 'last_message')) {
      await this.#db.exec(`ALTER TABLE conversations ADD COLUMN last_message TEXT NOT NULL DEFAULT ''`);
    }
  }

  /**
   * Processes a user message within a specified category and topic, generates an AI response using the stored conversation history and summary context, and updates the conversation. If the category or topic doesn't exist, it will be created.
   * @param {string} category
   * @param {string} topic
   * @param {string} userMessage
   * @param {string[]} [contextSources] - Optional names of context providers to inject (e.g. "kanban-rundown")
   * @returns {Promise<{response: string, conversationId: number}>}
   */
  async chat(category, topic, userMessage, contextSources = []) {
    const stage = "chat";
    try {
      if (!category?.trim() || !topic?.trim() || !userMessage?.trim())
        throw new Error(`[${stage}] Invalid input: category, topic, and userMessage are required`);

      const categoryRow = this.#db.exec(
        `INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id, summary`,
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

      const contextParts = [];
      if (categoryRow.summary) contextParts.push(`Category context: ${categoryRow.summary}`);
      if (topicRow.summary) contextParts.push(`Topic context: ${topicRow.summary}`);
      if (!contextParts.length) contextParts.push("You have no prior context about this topic. Ask the user about their situation if needed.");

      if (contextSources.length) {
        const injected = await resolveContexts(this.env, this, contextSources);
        contextParts.push(...injected);
      }

      const systemPrompt = [
        this.env.AI_SYSTEM_INSTRUCTION,
        `You are a personal assistant helping with: ${category} / ${topic}.`,
        ...contextParts
      ].join("\n");

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

      const kanbanKey = this.env.KANBANFLOW_API_KEY;
      const allowTaskCreation = kanbanKey && contextSources.includes("kanban-create");
      let modifiedMessage = assistantMessage;
      let boardColumnsCache = null;
      const getColumnId = async (colName) => {
        if (!boardColumnsCache) {
          const board = await this.#fetchKanban(kanbanKey, "/board");
          boardColumnsCache = board.columns;
        }
        const column = boardColumnsCache.find(c => c.name === colName);
        if (!column) throw new Error(`Column not found: ${colName}`);
        return column.uniqueId;
      };

      const blockRegex = /⧉ CREATE TASK\n([\s\S]*?)(?:⧉ END|\n\n|$)/g;
      let blockMatch;
      while ((blockMatch = blockRegex.exec(assistantMessage)) !== null) {
        const raw = blockMatch[1].trim();
        if (!raw) continue;
        const nameMatch = raw.match(/^Name:\s*(.+)$/m);
        const colMatch = raw.match(/^Column:\s*(.+)$/m);
        const descMatch = raw.match(/^Description:\s*(.+)$/m);
        const taskName = nameMatch?.[1]?.trim();
        const columnName = colMatch?.[1]?.trim();
        const description = descMatch?.[1]?.trim();
        if (allowTaskCreation && taskName) {
          try {
            const columnId = columnName ? await getColumnId(columnName) : undefined;
            await this.createKanbanTask(kanbanKey, taskName, columnId, description);
            modifiedMessage = modifiedMessage.replace(blockMatch[0], `✅ Task created: "${taskName}"${columnName ? ` in ${columnName}` : ""}`);
          } catch (err) {
            modifiedMessage = modifiedMessage.replace(blockMatch[0], `❌ Failed to create task "${taskName}": ${err.message}`);
          }
        }
      }

      const inlineRegex = /⧉ CREATE TASK:\s*(.+?)\s*→\s*(.+?)(?:\n|$)/g;
      let inlineMatch;
      while ((inlineMatch = inlineRegex.exec(assistantMessage)) !== null) {
        if (modifiedMessage.includes(inlineMatch[0])) {
          const taskName = inlineMatch[1].trim();
          const columnName = inlineMatch[2].trim();
          if (allowTaskCreation && taskName && columnName) {
            try {
              const columnId = await getColumnId(columnName);
              await this.createKanbanTask(kanbanKey, taskName, columnId);
              modifiedMessage = modifiedMessage.replace(inlineMatch[0], `✅ Task created: "${taskName}" in ${columnName}`);
            } catch (err) {
              modifiedMessage = modifiedMessage.replace(inlineMatch[0], `❌ Failed to create task "${taskName}": ${err.message}`);
            }
          }
        }
      }

      messages.push({ role: "assistant", content: modifiedMessage });

      const lastMsg = (messages[messages.length - 1]?.content || "").slice(0, 200);
      this.#db.exec(
        `UPDATE conversations SET messages = ?, last_message = ? WHERE id = ?`,
        JSON.stringify(messages), lastMsg, conversationId
      );
      console.log(`[INFO][${stage}] Conversation updated: id=${conversationId}, messages=${messages.length}`);

      return { response: modifiedMessage, conversationId };
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
         WHERE topic_id = ? AND created_at_timestamp >= ?
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
        `Update the summary by incorporating the following NEW messages. Category: ${topic.category_name}, Topic: ${topic.name}. Messages are labeled with role fields ("user" and "assistant"). Prioritize "user" messages — they represent confirmed information and intent. "assistant" messages are speculative; only include their content if the user explicitly agreed or confirmed it. Be conservative — avoid adding unconfirmed assumptions.`
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
         WHERE category_id = ? AND summary != '' AND updated_at_timestamp >= ?`,
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

  /**
   * Returns all conversations with category, topic, timestamp, and last message preview, ordered by most recent.
   * @returns {Promise<Array<{id: number, category: string, topic: string, created_at: number, last_message: string}>>}
   */
  async listConversations() {
    const stage = "listConversations";
    try {
      const rows = [...this.#db.exec(`
        SELECT c.id, c.created_at_timestamp, c.last_message, cat.name as category, t.name as topic
        FROM conversations c
        JOIN topics t ON t.id = c.topic_id
        JOIN categories cat ON cat.id = t.category_id
        ORDER BY c.created_at_timestamp DESC
        LIMIT 50
      `).toArray()];
      const result = rows.map(r => ({
        id: r.id, category: r.category, topic: r.topic, created_at: r.created_at_timestamp,
        last_message: (r.last_message || "").slice(0, 80)
      }));
      console.log(`[INFO][${stage}] Listed ${result.length} conversations`);
      return result;
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  /**
   * Deletes a conversation by id.
   * @param {number} id
   * @returns {Promise<{success: boolean}>}
   */
  async deleteConversation(id) {
    const stage = "deleteConversation";
    try {
      this.#db.exec(`DELETE FROM conversations WHERE id = ?`, id);
      console.log(`[INFO][${stage}] Deleted conversation: id=${id}`);
      return { success: true };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  /**
   * Returns a single conversation with its messages.
   * @param {number} id
   * @returns {Promise<{id: number, category: string, topic: string, messages: Array<{role: string, content: string}>}>}
   */
  async getConversation(id) {
    const stage = "getConversation";
    try {
      const row = this.#db.exec(`
        SELECT c.id, c.messages, cat.name as category, t.name as topic
        FROM conversations c
        JOIN topics t ON t.id = c.topic_id
        JOIN categories cat ON cat.id = t.category_id
        WHERE c.id = ?
      `, id).one();
      if (!row) throw new Error(`Conversation not found: ${id}`);
      const messages = JSON.parse(row.messages);
      console.log(`[INFO][${stage}] Fetched conversation: id=${id}, messages=${messages.length}`);
      return { id: row.id, category: row.category, topic: row.topic, messages };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  #fetchKanban(apiKey, path) {
    return fetch(`https://kanbanflow.com/api/v1${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    }).then(res => {
      if (!res.ok) throw new Error(`KanbanFlow API error: ${res.status} ${res.statusText}`);
      return res.json();
    });
  }

  /**
   * Fetches the KanbanFlow board structure including column names and IDs.
   * @param {string} kanbanApiKey
   * @returns {Promise<{columns: Array<{name: string, uniqueId: string}>, name: string}>}
   */
  async getKanbanBoard(kanbanApiKey) {
    const stage = "getKanbanBoard";
    try {
      const board = await this.#fetchKanban(kanbanApiKey, "/board");
      console.log(`[INFO][${stage}] Board fetched: ${board.name}, columns=${board.columns.length}`);
      return { columns: board.columns, name: board.name };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  /**
   * Creates a new task in the specified KanbanFlow column.
   * @param {string} kanbanApiKey
   * @param {string} taskName
   * @param {string} [columnId] - Pre-resolved KanbanFlow column unique ID
   * @param {string} [description]
   * @returns {Promise<{success: boolean, taskId: string, taskName: string}>}
   */
  async createKanbanTask(kanbanApiKey, taskName, columnId, description) {
    const stage = "createKanbanTask";
    try {
      const body = { name: taskName };
      if (columnId?.trim()) body.columnId = columnId.trim();
      if (description?.trim()) body.description = description.trim();

      const res = await fetch("https://kanbanflow.com/api/v1/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kanbanApiKey}` },
        body: JSON.stringify(body)
      });

      if (!res.ok) throw new Error(`KanbanFlow create task error: ${res.status} ${res.statusText}`);
      const result = await res.json();

      console.log(`[INFO][${stage}] Task created: ${taskName}${columnId ? ` in column ${columnId}` : ""}`);
      return { success: true, taskId: result.taskId, taskName };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  #fetchAndFormatKanbanTasks(kanbanApiKey) {
    return Promise.all([
      this.#fetchKanban(kanbanApiKey, "/tasks"),
      this.#fetchKanban(kanbanApiKey, "/board")
    ]).then(([tasksData, board]) => {
      const columnMap = {};
      board.columns.forEach(c => { columnMap[c.uniqueId] = c.name; });

      const tasksByColumn = {};
      tasksData.forEach(group => {
        const colName = group.columnName || columnMap[group.columnId] || "Unknown";
        if (!tasksByColumn[colName]) tasksByColumn[colName] = [];
        (group.tasks || []).forEach(task => {
          const subtasks = task.subTasks?.length
            ? `\n  Subtasks: ${task.subTasks.map(s => `${s.name}${s.finished ? ' ✓' : ''}`).join(', ')}`
            : '';
          const color = task.color ? ` [${task.color}]` : '';
          tasksByColumn[colName].push(`- ${task.name}${color}${subtasks}`);
        });
      });

      return Object.entries(tasksByColumn)
        .map(([col, tasks]) => `### ${col}\n${tasks.join('\n')}`)
        .join('\n\n');
    });
  }

  /**
   * Returns raw KanbanFlow tasks grouped by column, formatted as markdown.
   * @param {string} kanbanApiKey
   * @returns {Promise<{tasks: string}>}
   */
  async getKanbanTasks(kanbanApiKey) {
    const stage = "getKanbanTasks";
    try {
      const tasks = await this.#fetchAndFormatKanbanTasks(kanbanApiKey);
      console.log(`[INFO][${stage}] Tasks formatted`);
      return { tasks: tasks || "No tasks found." };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  /**
   * Fetches all tasks from KanbanFlow, groups by column, and sends to AI
   * for a brief rundown and advice on what to start working on.
   * @param {string} kanbanApiKey
   * @param {string} [customPrompt]
   * @returns {Promise<{response: string}>}
   */
  async generateKanbanRundown(kanbanApiKey, customPrompt) {
    const stage = "generateKanbanRundown";
    try {
      const taskReport = await this.#fetchAndFormatKanbanTasks(kanbanApiKey);

      if (!taskReport.trim()) {
        return { response: "No tasks found on your KanbanFlow board." };
      }

      const defaultPrompt = `Here are my current KanbanFlow board tasks:\n\n${taskReport}\n\nPlease provide:\n1. A brief rundown of what I'm working on\n2. Advice on what task I should start working on first and why`;

      const prompt = customPrompt?.trim()
        ? `${customPrompt.trim()}\n\nTasks:\n${taskReport}`
        : defaultPrompt;

      const response = await this.#runAI(
        "You are a productive task manager. Be concise and direct.",
        prompt
      );

      console.log(`[INFO][${stage}] Rundown generated`);
      return { response };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  /**
   * Suggests a category and topic for a kanban task using AI, checking existing categories first.
   * @param {string} kanbanApiKey
   * @param {string} taskName
   * @param {string} [columnName]
   * @returns {Promise<{category: string, topic: string}>}
   */
  async suggestKanbanCategory(kanbanApiKey, taskName, columnName) {
    const stage = "suggestKanbanCategory";
    try {
      const existing = [...this.#db.exec("SELECT name FROM categories ORDER BY name").toArray()];
      const existingCategories = existing.map(c => c.name);

      const prompt = [
        "Suggest a category and topic for a KanbanFlow task.",
        `Task: "${taskName}"`,
        columnName ? `Column: "${columnName}"` : null,
        existingCategories.length ? `Existing categories: ${existingCategories.join(", ")}` : "No existing categories yet.",
        "If an existing category fits, use it. Otherwise create a concise new one.",
        "Respond with EXACTLY: CATEGORY: <name>\nTOPIC: <topic>"
      ].filter(Boolean).join("\n");

      const response = await this.#runAI(
        "You organize tasks into categories. Reply only with the requested format.",
        prompt
      );

      let category = "";
      let topic = "";
      for (const line of response.split("\n")) {
        if (line.startsWith("CATEGORY:")) category = line.slice(9).trim();
        if (line.startsWith("TOPIC:")) topic = line.slice(6).trim();
      }
      if (!category) category = columnName || "Kanban";
      if (!topic) topic = taskName.slice(0, 60);

      return { category, topic };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      return { category: columnName || "Kanban", topic: taskName.slice(0, 60) };
    }
  }

  /**
   * Suggests a category and topic for a chat message using AI, checking existing pairs first.
   * @param {string} message
   * @returns {Promise<{category: string, topic: string}>}
   */
  async suggestCategory(message) {
    const stage = "suggestCategory";
    try {
      const existing = [...this.#db.exec(`SELECT DISTINCT c.name as category, t.name as topic FROM categories c JOIN topics t ON t.category_id = c.id ORDER BY c.name`).toArray()];
      const existingPairs = existing.map(r => `${r.category}/${r.topic}`);

      const prompt = [
        "Suggest a category and topic for this message.",
        `Message: "${message}"`,
        existingPairs.length ? `Existing options: ${existingPairs.join(", ")}` : "No existing pairs yet.",
        "If an existing pair fits, use it. Otherwise create a concise new category and topic.",
        "Respond with EXACTLY: CATEGORY: <name>\nTOPIC: <topic>"
      ].filter(Boolean).join("\n");

      const response = await this.#runAI(
        "You categorize messages. Reply only with the requested format.",
        prompt
      );

      let category = "";
      let topic = "";
      for (const line of response.split("\n")) {
        if (line.startsWith("CATEGORY:")) category = line.slice(9).trim();
        if (line.startsWith("TOPIC:")) topic = line.slice(6).trim();
      }
      if (!category) category = "General";
      if (!topic) topic = message.slice(0, 60);

      return { category, topic };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      return { category: "General", topic: message.slice(0, 60) };
    }
  }

  /**
   * Stores messages as a new conversation in the given category/topic without calling AI.
   * Creates the category and topic if they don't exist.
   * @param {string} category
   * @param {string} topic
   * @param {Array<{role: string, content: string}>} messages
   * @returns {{conversationId: number}}
   */
  async storeConversationMessage(category, topic, messages) {
    const stage = "storeConversationMessage";
    try {
      const categoryRow = this.#db.exec(
        `INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id`,
        category.trim()
      ).one();

      const topicRow = this.#db.exec(
        `INSERT INTO topics (category_id, name) VALUES (?, ?) ON CONFLICT(category_id, name) DO UPDATE SET name=name RETURNING id`,
        categoryRow.id, topic.trim()
      ).one();

      const conv = this.#db.exec(
        `INSERT INTO conversations (topic_id, messages) VALUES (?, ?) RETURNING id`,
        topicRow.id, JSON.stringify(messages)
      ).one();

      console.log(`[INFO][${stage}] Stored ${messages.length} messages in ${category}/${topic}, conversation=${conv.id}`);
      return { conversationId: conv.id };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  /**
   * Exports all categories, topics, and conversations as a portable JSON structure.
   * Messages are parsed from their JSON string storage into arrays for readability.
   * @returns {Promise<{version: number, exported_at: string, categories: Array<{name: string, summary: string, updated_at_timestamp: number, topics: Array<{name: string, summary: string, updated_at_timestamp: number, conversations: Array<{messages: Array<{role: string, content: string}>, last_message: string, created_at_timestamp: number}>}>}>}>}
   */
  async exportData() {
    const stage = "exportData";
    try {
      const categories = [...this.#db.exec(`SELECT id, name, summary, updated_at_timestamp FROM categories ORDER BY name`).toArray()];
      const result = [];
      for (const cat of categories) {
        const topics = [...this.#db.exec(
          `SELECT id, name, summary, updated_at_timestamp FROM topics WHERE category_id = ? ORDER BY name`,
          cat.id
        ).toArray()];
        const topicData = [];
        for (const topic of topics) {
          const conversations = [...this.#db.exec(
            `SELECT id, messages, last_message, created_at_timestamp FROM conversations WHERE topic_id = ? ORDER BY created_at_timestamp ASC`,
            topic.id
          ).toArray()];
          topicData.push({
            name: topic.name,
            summary: topic.summary,
            updated_at_timestamp: topic.updated_at_timestamp,
            conversations: conversations.map(c => ({
              messages: JSON.parse(c.messages),
              last_message: c.last_message,
              created_at_timestamp: c.created_at_timestamp
            }))
          });
        }
        result.push({
          name: cat.name,
          summary: cat.summary,
          updated_at_timestamp: cat.updated_at_timestamp,
          topics: topicData
        });
      }
      console.log(`[INFO][${stage}] Exported ${result.length} categories`);
      return { version: 1, exported_at: new Date().toISOString(), categories: result };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  /**
   * Imports categories, topics, and conversations from an export JSON object.
   * New categories/topics are inserted; existing ones (matched by name) are skipped
   * and reported in the conflicts response. Conversations under new topics are always inserted.
   * @param {{version?: number, exported_at?: string, categories: Array<{name: string, summary?: string, updated_at_timestamp?: number, topics?: Array<{name: string, summary?: string, updated_at_timestamp?: number, conversations?: Array<{messages?: Array<{role: string, content: string}>, last_message?: string, created_at_timestamp?: number}>}>}>}} data
   * @returns {Promise<{imported: {categories: number, topics: number, conversations: number}, conflicts: {categories: string[], topics: string[]}}>}
   */
  async importData(data) {
    const stage = "importData";
    const imported = { categories: 0, topics: 0, conversations: 0 };
    const conflicts = { categories: [], topics: [] };
    try {
      for (const cat of (data.categories || [])) {
        if (!cat.name?.trim()) {
          console.log(`[INFO][${stage}] Skipping unnamed category`);
          continue;
        }
        const catRows = this.#db.exec(
          `INSERT INTO categories (name, summary, updated_at_timestamp) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING RETURNING id`,
          cat.name.trim(), cat.summary || '', cat.updated_at_timestamp || Math.floor(Date.now() / 1000)
        ).toArray();
        let catId;
        if (catRows.length) {
          catId = catRows[0].id;
          imported.categories++;
        } else {
          catId = this.#db.exec(`SELECT id FROM categories WHERE name = ?`, cat.name.trim()).one().id;
          conflicts.categories.push(cat.name.trim());
        }
        for (const topic of (cat.topics || [])) {
          if (!topic.name?.trim()) {
            console.log(`[INFO][${stage}] Skipping unnamed topic in category=${cat.name}`);
            continue;
          }
          const topicRows = this.#db.exec(
            `INSERT INTO topics (category_id, name, summary, updated_at_timestamp) VALUES (?, ?, ?, ?) ON CONFLICT(category_id, name) DO NOTHING RETURNING id`,
            catId, topic.name.trim(), topic.summary || '', topic.updated_at_timestamp || Math.floor(Date.now() / 1000)
          ).toArray();
          let topicId;
          if (topicRows.length) {
            topicId = topicRows[0].id;
            imported.topics++;
          } else {
            conflicts.topics.push(`${cat.name.trim()}/${topic.name.trim()}`);
            continue;
          }
          for (const conv of (topic.conversations || [])) {
            const messages = Array.isArray(conv.messages) ? conv.messages : [];
            const lastMsg = conv.last_message || (messages.length ? (messages[messages.length - 1]?.content || "").slice(0, 200) : "");
            this.#db.exec(
              `INSERT INTO conversations (topic_id, messages, last_message, created_at_timestamp) VALUES (?, ?, ?, ?)`,
              topicId, JSON.stringify(messages), lastMsg, conv.created_at_timestamp || Math.floor(Date.now() / 1000)
            );
            imported.conversations++;
          }
        }
      }
      console.log(`[INFO][${stage}] Imported: ${JSON.stringify(imported)}, conflicts: ${JSON.stringify(conflicts)}`);
      return { imported, conflicts };
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

      if (event.cron === "0 11 * * *") {
        const kanbanApiKey = env.KANBANFLOW_API_KEY;
        if (kanbanApiKey) {
          const result = await stub.generateKanbanRundown(kanbanApiKey);
          const today = new Date().toISOString().split("T")[0];
          await stub.storeConversationMessage("Kanban", today, [
            { role: "assistant", content: result.response }
          ]);
          console.log(`[INFO][${stage}] Scheduled kanban rundown stored in Kanban/${today}`);
        } else {
          console.log(`[INFO][${stage}] Skipping kanban rundown: KANBANFLOW_API_KEY not set`);
        }
      } else {
        await stub.updateAllSummaries();
        console.log(`[INFO][${stage}] Scheduled summary update complete`);
      }
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

      if (request.method === "GET" && url.pathname === "/context-sources") {
        return Response.json(listContextSources());
      }

      if (request.method === "POST" && url.pathname === "/chat") {
        let body;
        try { body = await request.json(); } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const { category, topic, message, contextSources: rawContextSources } = body ?? {};
        const contextSources = Array.isArray(rawContextSources) ? rawContextSources : [];
        if (!category?.trim() || !topic?.trim() || !message?.trim())
          return Response.json({ error: "category, topic, and message are required" }, { status: 400 });

        console.log(`[INFO][${stage}] Chat request: category=${category}, topic=${topic}, contextSources=${JSON.stringify(contextSources)}`);
        const result = await stub.chat(category, topic, message, contextSources);
        return Response.json(result);
      }

      if (request.method === "GET" && url.pathname === "/categories") {
        console.log(`[INFO][${stage}] Fetching categories`);
        const categories = await stub.getCategories();
        return Response.json(categories);
      }

      if (request.method === "GET" && url.pathname === "/conversations") {
        console.log(`[INFO][${stage}] Listing conversations`);
        const result = await stub.listConversations();
        return Response.json(result);
      }

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

      if (request.method === "POST" && url.pathname === "/suggest-category") {
        let body;
        try { body = await request.json(); } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        if (!body?.message?.trim())
          return Response.json({ error: "message is required" }, { status: 400 });

        const result = await stub.suggestCategory(body.message.trim());
        return Response.json(result);
      }

      if (request.method === "POST" && url.pathname === "/kanban-board") {
        let body;
        try { body = await request.json(); } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const kanbanApiKey = body?.kanbanApiKey || env.KANBANFLOW_API_KEY;
        if (!kanbanApiKey) return Response.json({ error: "KanbanFlow API key is required. Set KANBANFLOW_API_KEY secret or pass it in the request body." }, { status: 400 });

        console.log(`[INFO][${stage}] Fetching kanban board`);
        const result = await stub.getKanbanBoard(kanbanApiKey);
        return Response.json(result);
      }

      if (request.method === "POST" && url.pathname === "/kanban-suggest-category") {
        let body;
        try { body = await request.json(); } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const kanbanApiKey = body?.kanbanApiKey || env.KANBANFLOW_API_KEY;
        if (!kanbanApiKey) return Response.json({ error: "KanbanFlow API key is required." }, { status: 400 });
        if (!body?.taskName?.trim())
          return Response.json({ error: "taskName is required" }, { status: 400 });

        const result = await stub.suggestKanbanCategory(kanbanApiKey, body.taskName.trim(), body?.columnName?.trim());
        return Response.json(result);
      }

      if (request.method === "POST" && url.pathname === "/kanban-create-task") {
        let body;
        try { body = await request.json(); } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const kanbanApiKey = body?.kanbanApiKey || env.KANBANFLOW_API_KEY;
        if (!kanbanApiKey) return Response.json({ error: "KanbanFlow API key is required." }, { status: 400 });
        if (!body?.taskName?.trim() || !body?.columnName?.trim())
          return Response.json({ error: "taskName and columnName are required" }, { status: 400 });

        console.log(`[INFO][${stage}] Creating kanban task: ${body.taskName} in ${body.columnName}`);
        const board = await stub.getKanbanBoard(kanbanApiKey);
        const column = board.columns.find(c => c.name === body.columnName.trim());
        if (!column) return Response.json({ error: `Column not found: ${body.columnName}` }, { status: 400 });
        const taskResult = await stub.createKanbanTask(kanbanApiKey, body.taskName.trim(), column.uniqueId);

        if (taskResult.success && body?.category?.trim() && body?.topic?.trim()) {
          try {
            await stub.storeConversationMessage(body.category.trim(), body.topic.trim(), [
              { role: "user", content: `Created kanban task "${body.taskName}" in ${body.columnName}` },
              { role: "assistant", content: `✅ Task created: "${body.taskName}" in ${body.columnName}` }
            ]);
          } catch (err) {
            console.error(`[ERROR][${stage}] Failed to store conversation: ${err.message}`);
          }
        }

        return Response.json({ ...taskResult, columnName: body.columnName.trim() });
      }

      if (request.method === "POST" && url.pathname === "/kanban-rundown") {
        let body;
        try { body = await request.json(); } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const kanbanApiKey = body?.kanbanApiKey || env.KANBANFLOW_API_KEY;
        if (!kanbanApiKey) return Response.json({ error: "KanbanFlow API key is required." }, { status: 400 });

        console.log(`[INFO][${stage}] Generating kanban rundown`);
        const result = await stub.generateKanbanRundown(kanbanApiKey, body?.customPrompt);
        return Response.json(result);
      }

      if (request.method === "POST" && url.pathname === "/export") {
        console.log(`[INFO][${stage}] Exporting all data`);
        const result = await stub.exportData();
        return Response.json(result);
      }

      if (request.method === "POST" && url.pathname === "/import") {
        let body;
        try { body = await request.json(); } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        if (!body?.data) {
          return Response.json({ error: "data field is required" }, { status: 400 });
        }
        console.log(`[INFO][${stage}] Importing data`);
        const result = await stub.importData(body.data);
        return Response.json(result);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  }
};
