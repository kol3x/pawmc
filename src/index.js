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

  #generateToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
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

    await this.#db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      CREATE TABLE IF NOT EXISTS channel_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        worker_url TEXT DEFAULT '',
        joined_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS channel_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL,
        member_id INTEGER NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        approved_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (member_id) REFERENCES channel_members(id) ON DELETE CASCADE,
        UNIQUE(channel_id, member_id)
      );

      CREATE TABLE IF NOT EXISTS channel_memberships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        hub_url TEXT NOT NULL,
        member_token TEXT NOT NULL,
        display_name TEXT NOT NULL,
        category_mapping TEXT DEFAULT '[]',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(channel_id, hub_url)
      );

      CREATE TABLE IF NOT EXISTS pending_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        membership_id INTEGER NOT NULL,
        draft TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        approved_content TEXT DEFAULT '',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (membership_id) REFERENCES channel_memberships(id) ON DELETE CASCADE
      );
    `);
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
      let modifiedMessage = assistantMessage;

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
        if (kanbanKey && taskName) {
          try {
            await this.createKanbanTask(kanbanKey, taskName, columnName, description);
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
          if (kanbanKey && taskName && columnName) {
            try {
              await this.createKanbanTask(kanbanKey, taskName, columnName);
              modifiedMessage = modifiedMessage.replace(inlineMatch[0], `✅ Task created: "${taskName}" in ${columnName}`);
            } catch (err) {
              modifiedMessage = modifiedMessage.replace(inlineMatch[0], `❌ Failed to create task "${taskName}": ${err.message}`);
            }
          }
        }
      }

      messages.push({ role: "assistant", content: modifiedMessage });

      this.#db.exec(
        `UPDATE conversations SET messages = ? WHERE id = ?`,
        JSON.stringify(messages), conversationId
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
        SELECT c.id, c.created_at_timestamp, c.messages, cat.name as category, t.name as topic
        FROM conversations c
        JOIN topics t ON t.id = c.topic_id
        JOIN categories cat ON cat.id = t.category_id
        ORDER BY c.created_at_timestamp DESC
        LIMIT 50
      `).toArray()];
      const result = rows.map(r => {
        let lastMessage = "";
        try {
          const msgs = JSON.parse(r.messages);
          const last = msgs[msgs.length - 1];
          if (last) lastMessage = (last.content || last.text || "").slice(0, 80);
        } catch {}
        return { id: r.id, category: r.category, topic: r.topic, created_at: r.created_at_timestamp, last_message: lastMessage };
      });
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
   * @param {string} [columnName]
   * @param {string} [description]
   * @returns {Promise<{success: boolean, taskId: string, taskName: string, columnName: string}>}
   */
  async createKanbanTask(kanbanApiKey, taskName, columnName, description) {
    const stage = "createKanbanTask";
    try {
      const body = { name: taskName };
      if (columnName?.trim()) {
        const board = await this.#fetchKanban(kanbanApiKey, "/board");
        const column = board.columns.find(c => c.name === columnName);
        if (!column) throw new Error(`Column not found: ${columnName}`);
        body.columnId = column.uniqueId;
      }
      if (description?.trim()) body.description = description.trim();

      const res = await fetch("https://kanbanflow.com/api/v1/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kanbanApiKey}` },
        body: JSON.stringify(body)
      });

      if (!res.ok) throw new Error(`KanbanFlow create task error: ${res.status} ${res.statusText}`);
      const result = await res.json();

      console.log(`[INFO][${stage}] Task created: ${taskName}${columnName ? ` in ${columnName}` : ""}`);
      return { success: true, taskId: result.taskId, taskName, columnName: columnName || "" };
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

  // ─── Channels: Hub-facing (called by other instances) ───

  async hubJoinChannel(inviteCode, displayName, workerUrl) {
    const stage = "hubJoinChannel";
    try {
      const inviteData = await this.state.storage.get("inviteCode:" + inviteCode);
      if (!inviteData) throw new Error("Invalid invite code");
      const now = Math.floor(Date.now() / 1000);
      if (now - inviteData.createdAt > 86400) {
        await this.state.storage.delete("inviteCode:" + inviteCode);
        throw new Error("Invite code expired");
      }
      const member = this.#db.exec(
        `INSERT INTO channel_members (channel_id, display_name, worker_url) VALUES (?, ?, ?) RETURNING id`,
        inviteData.channelId, displayName, workerUrl || ""
      ).one();
      const memberToken = this.#generateToken();
      await this.state.storage.put("memberToken:" + memberToken, { memberId: member.id, channelId: inviteData.channelId });
      await this.state.storage.delete("inviteCode:" + inviteCode);
      console.log(`[INFO][${stage}] Member joined: channel=${inviteData.channelId}, displayName=${displayName}`);
      return { channelId: inviteData.channelId, memberToken };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  async hubPushCard(channelId, memberToken, content) {
    const stage = "hubPushCard";
    try {
      const tokenData = await this.state.storage.get("memberToken:" + memberToken);
      if (!tokenData) throw new Error("Invalid member token");
      if (tokenData.channelId !== channelId) throw new Error("Token not valid for this channel");
      this.#db.exec(
        `INSERT INTO channel_cards (channel_id, member_id, content, approved_at) VALUES (?, ?, ?, strftime('%s', 'now'))
         ON CONFLICT(channel_id, member_id) DO UPDATE SET content = ?, approved_at = strftime('%s', 'now')`,
        channelId, tokenData.memberId, content, content
      );
      console.log(`[INFO][${stage}] Card pushed: channel=${channelId}, member=${tokenData.memberId}`);
      return { success: true };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  async hubGetCards(channelId, memberToken) {
    const stage = "hubGetCards";
    try {
      const tokenData = await this.state.storage.get("memberToken:" + memberToken);
      if (!tokenData) throw new Error("Invalid member token");
      if (tokenData.channelId !== channelId) throw new Error("Token not valid for this channel");
      const cards = [...this.#db.exec(`
        SELECT cm.display_name, cc.content, cc.approved_at
        FROM channel_cards cc
        JOIN channel_members cm ON cm.id = cc.member_id
        WHERE cc.channel_id = ?
        ORDER BY cm.display_name
      `, channelId).toArray()];
      return cards;
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  async hubRemoveMember(channelId, memberToken) {
    const stage = "hubRemoveMember";
    try {
      const tokenData = await this.state.storage.get("memberToken:" + memberToken);
      if (!tokenData) throw new Error("Invalid member token");
      if (tokenData.channelId !== channelId) throw new Error("Token not valid for this channel");
      this.#db.exec(`DELETE FROM channel_cards WHERE channel_id = ? AND member_id = ?`, channelId, tokenData.memberId);
      this.#db.exec(`DELETE FROM channel_members WHERE id = ?`, tokenData.memberId);
      await this.state.storage.delete("memberToken:" + memberToken);
      console.log(`[INFO][${stage}] Member removed: channel=${channelId}, member=${tokenData.memberId}`);
      return { success: true };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  // ─── Channels: Member-facing (called by client) ───

  async createChannel(name, displayName) {
    const stage = "createChannel";
    try {
      const channel = this.#db.exec(
        `INSERT INTO channels (name) VALUES (?) RETURNING id, created_at`,
        name
      ).one();
      this.#db.exec(
        `INSERT INTO channel_members (channel_id, display_name, worker_url) VALUES (?, ?, '__host__')`,
        channel.id, displayName || "Me"
      );
      const inviteCode = this.#generateToken();
      await this.state.storage.put("inviteCode:" + inviteCode, {
        channelId: channel.id,
        createdAt: Math.floor(Date.now() / 1000)
      });
      console.log(`[INFO][${stage}] Channel created: id=${channel.id}, name=${name}`);
      return { channelId: channel.id, inviteCode };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  async reinviteChannel(channelId) {
    const stage = "reinviteChannel";
    try {
      const channel = this.#db.exec(`SELECT id FROM channels WHERE id = ?`, channelId).one();
      if (!channel) throw new Error("Channel not found");
      const inviteCode = this.#generateToken();
      await this.state.storage.put("inviteCode:" + inviteCode, {
        channelId: channel.id,
        createdAt: Math.floor(Date.now() / 1000)
      });
      return { inviteCode };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  async joinChannel(hubUrl, inviteCode, displayName) {
    const stage = "joinChannel";
    try {
      const response = await fetch(`${hubUrl.replace(/\/+$/, "")}/hub/channels/join`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${inviteCode}`
        },
        body: JSON.stringify({ displayName, workerUrl: "" })
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "Failed to join channel");
      }
      const data = await response.json();
      const membership = this.#db.exec(
        `INSERT INTO channel_memberships (channel_id, hub_url, member_token, display_name) VALUES (?, ?, ?, ?) RETURNING id`,
        String(data.channelId), hubUrl.replace(/\/+$/, ""), data.memberToken, displayName
      ).one();
      console.log(`[INFO][${stage}] Joined channel: id=${data.channelId}, hub=${hubUrl}`);
      return { channelId: data.channelId, membershipId: membership.id };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  async getChannels() {
    const stage = "getChannels";
    try {
      const hosted = [...this.#db.exec(`
        SELECT c.id, c.name, c.created_at, COUNT(cm.id) as member_count
        FROM channels c
        LEFT JOIN channel_members cm ON cm.channel_id = c.id
        GROUP BY c.id
        ORDER BY c.name
      `).toArray()].map(c => ({ ...c, role: "host" }));
      const joined = [...this.#db.exec(`
        SELECT cm.id as membership_id, cm.channel_id, cm.hub_url, cm.display_name, cm.category_mapping
        FROM channel_memberships cm
        ORDER BY cm.created_at DESC
      `).toArray()].map(m => {
        const pending = this.#db.exec(
          `SELECT draft, status, approved_content FROM pending_cards WHERE membership_id = ? AND status != 'rejected' ORDER BY created_at DESC LIMIT 1`,
          m.membership_id
        ).toArray();
        return {
          membershipId: m.membership_id,
          channelId: m.channel_id,
          hubUrl: m.hub_url,
          displayName: m.display_name,
          categoryMapping: JSON.parse(m.category_mapping || "[]"),
          pendingCard: pending[0] || null,
          role: "member"
        };
      });
      return { hosted, joined };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  async getChannelView(channelId) {
    const stage = "getChannelView";
    try {
      if (!String(channelId).startsWith("m")) {
        const channel = this.#db.exec(`SELECT id, name FROM channels WHERE id = ?`, parseInt(channelId)).one();
        if (!channel) throw new Error("Channel not found");
        const cards = [...this.#db.exec(`
          SELECT cm.display_name, cc.content, cc.approved_at
          FROM channel_cards cc
          JOIN channel_members cm ON cm.id = cc.member_id
          WHERE cc.channel_id = ?
          ORDER BY cm.display_name
        `, channel.id).toArray()];
        return { channelName: channel.name, members: cards, isHub: true };
      }
      const membershipId = parseInt(String(channelId).slice(1));
      const membership = this.#db.exec(
        `SELECT id, hub_url, member_token, channel_id FROM channel_memberships WHERE id = ?`,
        membershipId
      ).one();
      if (!membership) throw new Error("Channel not found");
      const response = await fetch(`${membership.hub_url}/hub/channels/${membership.channel_id}/cards`, {
        headers: { "Authorization": `Bearer ${membership.member_token}` }
      });
      if (!response.ok) throw new Error("Failed to fetch channel view");
      const cards = await response.json();
      const pending = this.#db.exec(
        `SELECT draft, status, approved_content FROM pending_cards
         WHERE membership_id = ? AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
        membership.id
      ).toArray();
      return { members: cards, pendingCard: pending[0] || null, isHub: false };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  async suggestCard(channelId) {
    const stage = "suggestCard";
    try {
      let categories = [];
      let membershipId = null;
      if (!String(channelId).startsWith("m")) {
        const channel = this.#db.exec(`SELECT id FROM channels WHERE id = ?`, parseInt(channelId)).one();
        if (!channel) throw new Error("Channel not found");
        const allCats = [...this.#db.exec(`SELECT name FROM categories`).toArray()];
        categories = allCats.map(c => c.name);
      } else {
        membershipId = parseInt(String(channelId).slice(1));
        const membership = this.#db.exec(
          `SELECT id, category_mapping FROM channel_memberships WHERE id = ?`,
          membershipId
        ).one();
        if (!membership) throw new Error("Channel not found");
        categories = JSON.parse(membership.category_mapping || "[]");
        membershipId = membership.id;
      }
      let contextData = "";
      if (categories.length) {
        const placeholders = categories.map(() => "?").join(",");
        const conversations = [...this.#db.exec(`
          SELECT c.messages, cat.name as category, t.name as topic
          FROM conversations c
          JOIN topics t ON t.id = c.topic_id
          JOIN categories cat ON cat.id = t.category_id
          WHERE cat.name IN (${placeholders})
          ORDER BY c.created_at_timestamp DESC
          LIMIT 10
        `, ...categories).toArray()];
        contextData = conversations.map(c => {
          try {
            const msgs = JSON.parse(c.messages);
            const last = msgs.length > 0 ? msgs[msgs.length - 1].content || "" : "";
            return `[${c.category}/${c.topic}]: ${last.slice(0, 200)}`;
          } catch { return ""; }
        }).filter(Boolean).join("\n");
      }
      const userContent = contextData || "No recent activity found in mapped categories.";
      const draft = await this.#runAI(
        "Based on the user's recent activity, draft a 1-2 sentence update about what they're focused on right now. Make it suitable for sharing with a group — no sensitive details, no confidential information. Focus on high-level goals and themes. Reply with ONLY the draft text, no prefix or labels.",
        userContent
      );
      if (membershipId) {
        const existing = this.#db.exec(
          `SELECT id FROM pending_cards WHERE membership_id = ? ORDER BY created_at DESC LIMIT 1`,
          membershipId
        ).toArray();
        if (existing.length) {
          this.#db.exec(`UPDATE pending_cards SET draft = ?, status = 'pending', updated_at = strftime('%s', 'now') WHERE id = ?`, draft, existing[0].id);
        } else {
          this.#db.exec(`INSERT INTO pending_cards (membership_id, draft, status) VALUES (?, ?, 'pending')`, membershipId, draft);
        }
      }
      return { draft };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  async approveCard(channelId, content) {
    const stage = "approveCard";
    try {
      if (!String(channelId).startsWith("m")) {
        const channel = this.#db.exec(`SELECT id FROM channels WHERE id = ?`, parseInt(channelId)).one();
        if (!channel) throw new Error("Channel not found");
        const member = this.#db.exec(
          `SELECT id FROM channel_members WHERE channel_id = ? AND worker_url = '__host__'`,
          channel.id
        ).one();
        if (!member) throw new Error("Host member not found");
        this.#db.exec(
          `INSERT INTO channel_cards (channel_id, member_id, content, approved_at) VALUES (?, ?, ?, strftime('%s', 'now'))
           ON CONFLICT(channel_id, member_id) DO UPDATE SET content = ?, approved_at = strftime('%s', 'now')`,
          channel.id, member.id, content, content
        );
        return { success: true };
      }
      const membershipId = parseInt(String(channelId).slice(1));
      const membership = this.#db.exec(
        `SELECT id, hub_url, member_token, channel_id FROM channel_memberships WHERE id = ?`,
        membershipId
      ).one();
      if (!membership) throw new Error("Channel membership not found");
      const existing = this.#db.exec(
        `SELECT id FROM pending_cards WHERE membership_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
        membership.id
      ).toArray();
      if (existing.length) {
        this.#db.exec(
          `UPDATE pending_cards SET status = 'approved', approved_content = ?, updated_at = strftime('%s', 'now') WHERE id = ?`,
          content, existing[0].id
        );
      }
      const response = await fetch(`${membership.hub_url}/hub/channels/${membership.channel_id}/card`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${membership.member_token}`
        },
        body: JSON.stringify({ content })
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "Failed to push card to hub");
      }
      return { success: true };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  async mapChannel(channelId, categories) {
    const stage = "mapChannel";
    try {
      const membershipId = parseInt(String(channelId).slice(1));
      const membership = this.#db.exec(
        `SELECT id FROM channel_memberships WHERE id = ?`,
        membershipId
      ).one();
      if (!membership) throw new Error("Channel membership not found");
      this.#db.exec(
        `UPDATE channel_memberships SET category_mapping = ? WHERE id = ?`,
        JSON.stringify(categories || []), membership.id
      );
      return { success: true };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  async leaveChannel(channelId) {
    const stage = "leaveChannel";
    try {
      const membershipId = parseInt(String(channelId).slice(1));
      const membership = this.#db.exec(
        `SELECT id, hub_url, member_token, channel_id FROM channel_memberships WHERE id = ?`,
        membershipId
      ).one();
      if (!membership) throw new Error("Channel membership not found");
      await fetch(`${membership.hub_url}/hub/channels/${membership.channel_id}/member`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${membership.member_token}` }
      }).catch(() => {});
      this.#db.exec(`DELETE FROM pending_cards WHERE membership_id = ?`, membership.id);
      this.#db.exec(`DELETE FROM channel_memberships WHERE id = ?`, membership.id);
      return { success: true };
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      throw err;
    }
  }

  async deleteChannel(channelId) {
    const stage = "deleteChannel";
    try {
      const channel = this.#db.exec(`SELECT id FROM channels WHERE id = ?`, channelId).one();
      if (!channel) throw new Error("Channel not found");
      const members = [...this.#db.exec(`SELECT id FROM channel_members WHERE channel_id = ?`, channelId).toArray()];
      for (const m of members) {
        const tokens = await this.state.storage.list({ prefix: "memberToken:" });
        for (const [key, val] of tokens) {
          if (val.channelId === channelId) await this.state.storage.delete(key);
        }
      }
      const invites = await this.state.storage.list({ prefix: "inviteCode:" });
      for (const [key, val] of invites) {
        if (val.channelId === channelId) await this.state.storage.delete(key);
      }
      this.#db.exec(`DELETE FROM channels WHERE id = ?`, channelId);
      console.log(`[INFO][${stage}] Channel deleted: id=${channelId}`);
      return { success: true };
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

      if (url.pathname.startsWith("/hub/")) {
        const authHeader = request.headers.get("Authorization");
        const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

        if (request.method === "POST" && url.pathname === "/hub/channels/join") {
          let body;
          try { body = await request.json(); } catch { body = {}; }
          const result = await stub.hubJoinChannel(token, body.displayName || "", body.workerUrl || "");
          return Response.json(result);
        }

        const cardMatch = url.pathname.match(/^\/hub\/channels\/(\d+)\/card$/);
        if (request.method === "POST" && cardMatch) {
          let body;
          try { body = await request.json(); } catch { body = {}; }
          const result = await stub.hubPushCard(parseInt(cardMatch[1]), token, body.content || "");
          return Response.json(result);
        }

        const cardsMatch = url.pathname.match(/^\/hub\/channels\/(\d+)\/cards$/);
        if (request.method === "GET" && cardsMatch) {
          const result = await stub.hubGetCards(parseInt(cardsMatch[1]), token);
          return Response.json(result);
        }

        const memberMatch = url.pathname.match(/^\/hub\/channels\/(\d+)\/member$/);
        if (request.method === "DELETE" && memberMatch) {
          const result = await stub.hubRemoveMember(parseInt(memberMatch[1]), token);
          return Response.json(result);
        }

        return Response.json({ error: "Not found" }, { status: 404 });
      }

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
        const { category, topic, message, contextSources } = body ?? {};
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
        console.log(`[INFO][${stage}] Fetching conversation: id=${id}`);
        const result = await stub.getConversation(parseInt(id));
        return Response.json(result);
      }

      if (request.method === "DELETE" && url.pathname === "/conversation") {
        const id = url.searchParams.get("id");
        if (!id) return Response.json({ error: "id query parameter is required" }, { status: 400 });
        console.log(`[INFO][${stage}] Deleting conversation: id=${id}`);
        const result = await stub.deleteConversation(parseInt(id));
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
        const taskResult = await stub.createKanbanTask(kanbanApiKey, body.taskName.trim(), body.columnName.trim());

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

        return Response.json(taskResult);
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

      // ─── Channel routes ───

      if (request.method === "POST" && url.pathname === "/channels/create") {
        let body;
        try { body = await request.json(); } catch { body = {}; }
        if (!body?.name?.trim()) return Response.json({ error: "name is required" }, { status: 400 });
        const result = await stub.createChannel(body.name.trim(), body?.displayName?.trim() || "Me");
        return Response.json(result);
      }

      if (request.method === "POST" && url.pathname === "/channels/join") {
        let body;
        try { body = await request.json(); } catch { body = {}; }
        if (!body?.hubUrl?.trim() || !body?.inviteCode?.trim() || !body?.displayName?.trim())
          return Response.json({ error: "hubUrl, inviteCode, and displayName are required" }, { status: 400 });
        const result = await stub.joinChannel(body.hubUrl.trim(), body.inviteCode.trim(), body.displayName.trim());
        return Response.json(result);
      }

      if (request.method === "GET" && url.pathname === "/channels") {
        const result = await stub.getChannels();
        return Response.json(result);
      }

      const channelViewMatch = url.pathname.match(/^\/channels\/([^/]+)$/);
      if (request.method === "GET" && channelViewMatch) {
        const result = await stub.getChannelView(channelViewMatch[1]);
        return Response.json(result);
      }

      const suggestMatch = url.pathname.match(/^\/channels\/([^/]+)\/suggest-card$/);
      if (request.method === "POST" && suggestMatch) {
        const result = await stub.suggestCard(suggestMatch[1]);
        return Response.json(result);
      }

      const approveMatch = url.pathname.match(/^\/channels\/([^/]+)\/approve-card$/);
      if (request.method === "POST" && approveMatch) {
        let body;
        try { body = await request.json(); } catch { body = {}; }
        if (!body?.content?.trim()) return Response.json({ error: "content is required" }, { status: 400 });
        const result = await stub.approveCard(approveMatch[1], body.content.trim());
        return Response.json(result);
      }

      const mapMatch = url.pathname.match(/^\/channels\/([^/]+)\/map$/);
      if (request.method === "POST" && mapMatch) {
        let body;
        try { body = await request.json(); } catch { body = {}; }
        const result = await stub.mapChannel(mapMatch[1], body?.categories || []);
        return Response.json(result);
      }

      const leaveMatch = url.pathname.match(/^\/channels\/([^/]+)\/leave$/);
      if (request.method === "DELETE" && leaveMatch) {
        const result = await stub.leaveChannel(leaveMatch[1]);
        return Response.json(result);
      }

      const reinviteMatch = url.pathname.match(/^\/channels\/(\d+)\/reinvite$/);
      if (request.method === "POST" && reinviteMatch) {
        const result = await stub.reinviteChannel(parseInt(reinviteMatch[1]));
        return Response.json(result);
      }

      const deleteChMatch = url.pathname.match(/^\/channels\/(\d+)$/);
      if (request.method === "DELETE" && deleteChMatch) {
        const result = await stub.deleteChannel(parseInt(deleteChMatch[1]));
        return Response.json(result);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err) {
      console.error(`[ERROR][${stage}] ${err.message}`);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  }
};
