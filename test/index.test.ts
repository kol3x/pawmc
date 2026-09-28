import { env, exports } from "cloudflare:workers"
import { createExecutionContext, createScheduledController, runInDurableObject } from "cloudflare:test"
import { afterEach, expect, it, vi } from "vitest"
import worker, {
  type CategoryRow,
  type ChatResult,
  type ConversationDetail,
  type ConversationListEntry,
  type Env,
  type TopicNeededResult,
  type TopicRow,
} from "../src/index"

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

function request(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  headers.set("Authorization", "Bearer test-api-key")
  return new Request(`https://example.com${path}`, { ...init, headers })
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await exports.default.fetch(request(path, init))
  return { status: response.status, body: (await response.json()) as T }
}

async function postJson<T = unknown>(path: string, body?: unknown): Promise<{ status: number; body: T }> {
  return fetchJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function chat(category: string, topic: string, message: string, noteMode = false): Promise<ChatResult> {
  const result = await postJson<ChatResult>("/chat", { category, topic, message, noteMode })
  expect(result.status).toBe(200)
  return result.body
}

async function findTopic(categoryName: string, topicName: string): Promise<TopicRow> {
  const { body } = await fetchJson<CategoryRow[]>("/categories")
  const topic = body.find((c) => c.name === categoryName)?.topics.find((t) => t.name === topicName)
  expect(topic, `expected topic ${categoryName}/${topicName} to exist`).toBeDefined()
  return topic as TopicRow
}

async function findCategory(categoryName: string): Promise<CategoryRow> {
  const { body } = await fetchJson<CategoryRow[]>("/categories")
  const category = body.find((c) => c.name === categoryName)
  expect(category, `expected category ${categoryName} to exist`).toBeDefined()
  return category as CategoryRow
}

async function backdateConversations(seconds: number): Promise<void> {
  await runInDurableObject(env.ASSISTANT_DO.getByName("singleton"), (_instance, state) => {
    state.storage.sql.exec(`UPDATE conversations SET created_at_timestamp = created_at_timestamp - ?`, seconds)
  })
}

function stubOpenRouter(content: string | string[]): { bodies: Array<{ model?: string; messages: Array<{ role: string; content: string }> }> } {
  const responses = Array.isArray(content) ? content : [content]
  const bodies: Array<{ model?: string; messages: Array<{ role: string; content: string }> }> = []
  const original = globalThis.fetch
  let call = 0
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === OPENROUTER_URL) {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null)
      const reply = responses[Math.min(call++, responses.length - 1)]
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 })
    }
    return original(input, init)
  })
  return { bodies }
}

function stubOpenRouterByPrompt(map: Record<string, string>, fallback = "ok"): { bodies: Array<{ model?: string; messages: Array<{ role: string; content: string }> }> } {
  const bodies: Array<{ model?: string; messages: Array<{ role: string; content: string }> }> = []
  const original = globalThis.fetch
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === OPENROUTER_URL) {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      bodies.push(body)
      const serialized = JSON.stringify(body)
      const reply = Object.entries(map).find(([needle]) => serialized.includes(needle))?.[1] ?? fallback
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 })
    }
    return original(input, init)
  })
  return { bodies }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it("rejects requests without an api key", async () => {
  const response = await exports.default.fetch(new Request("https://example.com/categories"))
  expect(response.status).toBe(401)
})

it("rejects requests with a wrong api key", async () => {
  const response = await exports.default.fetch(
    new Request("https://example.com/categories", { headers: { Authorization: "Bearer nope" } }),
  )
  expect(response.status).toBe(401)
})

it("returns 404 for unknown routes", async () => {
  const { status } = await fetchJson("/nope")
  expect(status).toBe(404)
})

it("rejects invalid conversation ids", async () => {
  const { status } = await fetchJson("/conversation?id=abc")
  expect(status).toBe(400)
})

it("rejects chat requests with a blank message", async () => {
  const { status } = await postJson("/chat", { category: "qa-blank", topic: "t1", message: " " })
  expect(status).toBe(400)
})

it("rejects invalid json bodies", async () => {
  const response = await exports.default.fetch(
    request("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not-json" }),
  )
  expect(response.status).toBe(400)
})

it("stores chat conversations by category and topic", async () => {
  stubOpenRouter("reply-1")
  const result = await chat("qa-store", "t1", "hi there")
  expect(result.response).toBe("reply-1")
  expect(result.conversationId).toBeGreaterThan(0)

  const topic = await findTopic("qa-store", "t1")
  expect(topic.id).toBeGreaterThan(0)
})

it("builds chat prompts from category and topic", async () => {
  const { bodies } = stubOpenRouter("ok")
  await chat("qa-prompt", "t1", "hi")
  expect(bodies[0]?.messages[0]?.role).toBe("system")
  expect(bodies[0]?.messages[0]?.content).toContain("qa-prompt / t1")
})

it("reuses the latest conversation while it stays fresh", async () => {
  stubOpenRouter("ok")
  const first = await chat("qa-reuse", "t1", "one")
  const second = await chat("qa-reuse", "t1", "two")
  expect(second.conversationId).toBe(first.conversationId)

  const conversation = await fetchJson<ConversationDetail>(`/conversation?id=${first.conversationId}`)
  expect(conversation.body.messages.map((m) => m.content)).toEqual(["one", "ok", "two", "ok"])
})

it("starts a new conversation after the topic summary is updated", async () => {
  stubOpenRouter("ok")
  const first = await chat("qa-fresh", "t1", "one")
  await backdateConversations(10)
  const topic = await findTopic("qa-fresh", "t1")
  const updated = await postJson("/update-summary", { type: "topic", id: topic.id, summary: "remembered" })
  expect(updated.status).toBe(200)

  const second = await chat("qa-fresh", "t1", "two")
  expect(second.conversationId).not.toBe(first.conversationId)
})

it("resumes conversation reuse after a summary is forgotten", async () => {
  stubOpenRouter("ok")
  const first = await chat("qa-forget", "t1", "one")
  await backdateConversations(10)
  const topic = await findTopic("qa-forget", "t1")
  await postJson("/update-summary", { type: "topic", id: topic.id, summary: "temp" })
  const second = await chat("qa-forget", "t1", "two")
  expect(second.conversationId).not.toBe(first.conversationId)

  await postJson("/update-summary", { type: "topic", id: topic.id, summary: "" })
  const third = await chat("qa-forget", "t1", "three")
  expect(third.conversationId).toBe(second.conversationId)
})

it("stores note mode messages", async () => {
  stubOpenRouter("saved")
  const result = await chat("qa-notes", "t1", "remember this", true)
  expect(result.response).toBe("saved")

  const conversation = await fetchJson<ConversationDetail>(`/conversation?id=${result.conversationId}`)
  expect(conversation.body.messages.map((m) => m.content)).toEqual(["remember this", "saved"])
})

it("updates category summaries manually", async () => {
  stubOpenRouter("ok")
  await chat("qa-cats", "t1", "hi")
  const categories = await fetchJson<CategoryRow[]>("/categories")
  const category = categories.body.find((c) => c.name === "qa-cats")
  expect(category).toBeDefined()

  const updated = await postJson("/update-summary", {
    type: "category",
    id: category!.id,
    summary: "cat-level context",
  })
  expect(updated.status).toBe(200)

  const reread = await fetchJson<CategoryRow[]>("/categories")
  expect(reread.body.find((c) => c.name === "qa-cats")?.summary).toBe("cat-level context")
})

it("rejects invalid summary updates", async () => {
  const invalidType = await postJson("/update-summary", { type: "bogus", id: 1, summary: "s" })
  expect(invalidType.status).toBe(400)

  const invalidId = await postJson("/update-summary", { type: "topic", id: 0, summary: "s" })
  expect(invalidId.status).toBe(400)
})

it("generates topic summaries from new conversations", async () => {
  const { bodies } = stubOpenRouter("compounded context")
  await chat("qa-sum", "t1", "user fact one")

  const updated = await postJson("/update-summaries")
  expect(updated.status).toBe(200)

  const topic = await findTopic("qa-sum", "t1")
  expect(topic.summary).toBe("compounded context")
  const prompts = bodies.map((b) => b.messages.at(-1)?.content ?? "")
  expect(prompts.some((content) => content.includes("user fact one"))).toBe(true)
})

it("skips summarizing topics without new conversations", async () => {
  const { bodies } = stubOpenRouter("should not be called")
  await chat("qa-skip", "t1", "one")

  await postJson("/update-summaries")
  const callsForTopic = () => bodies.filter((b) => JSON.stringify(b).includes("qa-skip")).length
  const afterFirstRun = callsForTopic()
  expect(afterFirstRun).toBeGreaterThan(0)

  await backdateConversations(10)
  await postJson("/update-summaries")
  expect(callsForTopic()).toBe(afterFirstRun)
})

it("updates summaries on the cron schedule", async () => {
  stubOpenRouter("cron-compounded")
  await chat("qa-cron", "t1", "user fact")

  const controller = createScheduledController({ scheduledTime: new Date(), cron: "0 0 * * *" })
  await worker.scheduled(controller, env as Env, createExecutionContext())

  const topic = await findTopic("qa-cron", "t1")
  expect(topic.summary).toBe("cron-compounded")
})

it("lists conversations filtered by category", async () => {
  stubOpenRouter("ok")
  await chat("qa-list", "t1", "one")
  await chat("qa-list-other", "t1", "two")

  const listed = await fetchJson<ConversationListEntry[]>("/conversations?category=qa-list")
  expect(listed.body.length).toBeGreaterThan(0)
  expect(listed.body.every((c) => c.category === "qa-list")).toBe(true)
})

it("returns 404 for missing conversations", async () => {
  const { status } = await fetchJson("/conversation?id=99999999")
  expect(status).toBe(404)
})

it("deletes conversations by id", async () => {
  stubOpenRouter("ok")
  const result = await chat("qa-del", "t1", "one")

  const deleted = await fetchJson(`/conversation?id=${result.conversationId}`, { method: "DELETE" })
  expect(deleted.status).toBe(200)

  const gone = await fetchJson(`/conversation?id=${result.conversationId}`)
  expect(gone.status).toBe(404)
})

it("renames a category and keeps its topics", async () => {
  stubOpenRouter("ok")
  await chat("qa-rename", "t1", "one")
  const category = await findCategory("qa-rename")

  const renamed = await postJson("/rename-category", { id: category.id, name: "qa-renamed" })
  expect(renamed.status).toBe(200)
  expect(renamed.body).toEqual({ success: true })

  const after = await findCategory("qa-renamed")
  expect(after.topics.map((t) => t.name)).toContain("t1")
  const categories = await fetchJson<CategoryRow[]>("/categories")
  expect(categories.body.find((c) => c.name === "qa-rename")).toBeUndefined()
})

it("rejects renaming a category to an existing name", async () => {
  stubOpenRouter("ok")
  await chat("qa-rename-a", "t1", "one")
  await chat("qa-rename-b", "t1", "two")
  const a = await findCategory("qa-rename-a")

  const renamed = await postJson("/rename-category", { id: a.id, name: "qa-rename-b" })
  expect(renamed.status).toBe(409)
  expect(renamed.body).toEqual({ error: "Category name already exists" })
})

it("renames a topic and keeps its summary", async () => {
  stubOpenRouter("compounded context")
  await chat("qa-rename-t", "old topic", "one")
  await postJson("/update-summaries")
  const topic = await findTopic("qa-rename-t", "old topic")

  const renamed = await postJson("/rename-topic", { id: topic.id, name: "new topic" })
  expect(renamed.status).toBe(200)

  const renamedTopic = await findTopic("qa-rename-t", "new topic")
  expect(renamedTopic.summary).toBe("compounded context")
})

it("rejects renaming a topic to a sibling topic's name", async () => {
  stubOpenRouter("ok")
  await chat("qa-sib", "topic a", "one")
  await chat("qa-sib", "topic b", "two")
  const { body } = await fetchJson<CategoryRow[]>("/categories")
  const topicA = body.find((c) => c.name === "qa-sib")?.topics.find((t) => t.name === "topic a")

  const renamed = await postJson("/rename-topic", { id: topicA!.id, name: "topic b" })
  expect(renamed.status).toBe(409)
  expect(renamed.body).toEqual({ error: "Topic name already exists" })
})

it("returns 404 when renaming or deleting missing categories and topics", async () => {
  expect((await postJson("/rename-category", { id: 999999, name: "nope" })).status).toBe(404)
  expect((await postJson("/rename-topic", { id: 999999, name: "nope" })).status).toBe(404)
  expect((await fetchJson("/category?id=999999", { method: "DELETE" })).status).toBe(404)
  expect((await fetchJson("/topic?id=999999", { method: "DELETE" })).status).toBe(404)
})

it("deletes a topic with its conversations", async () => {
  stubOpenRouter("ok")
  const first = await chat("qa-del-topic", "t1", "one")
  const topic = await findTopic("qa-del-topic", "t1")

  const deleted = await fetchJson(`/topic?id=${topic.id}`, { method: "DELETE" })
  expect(deleted.status).toBe(200)

  expect((await fetchJson(`/conversation?id=${first.conversationId}`)).status).toBe(404)
  const after = await fetchJson<CategoryRow[]>("/categories")
  expect(after.body.find((c) => c.name === "qa-del-topic")?.topics ?? []).toHaveLength(0)
})

it("deletes a category with nested topics and conversations", async () => {
  stubOpenRouter("ok")
  const first = await chat("qa-del-cat", "t1", "one")
  const second = await chat("qa-del-cat", "t2", "two")
  const category = await findCategory("qa-del-cat")

  const deleted = await fetchJson(`/category?id=${category.id}`, { method: "DELETE" })
  expect(deleted.status).toBe(200)

  for (const id of [first.conversationId, second.conversationId]) {
    expect((await fetchJson(`/conversation?id=${id}`)).status).toBe(404)
  }
  const after = await fetchJson<CategoryRow[]>("/categories")
  expect(after.body.find((c) => c.name === "qa-del-cat")).toBeUndefined()
})

it("generates a new topic when the chat starts without one", async () => {
  const { bodies } = stubOpenRouter([
    '{"candidates":[{"topic":"project kickoff","confidence":0.95,"description":"planning the project kickoff"}]}',
    "Hello! Ready when you are.",
  ])
  const result = await postJson<ChatResult>("/chat", {
    category: "qa-autogen",
    message: "let's plan the project kickoff for next week",
  })
  expect(result.status).toBe(200)
  expect(result.body.topic).toBe("project kickoff")
  expect(result.body.topicId).toBeGreaterThan(0)
  const topic = await findTopic("qa-autogen", "project kickoff")
  expect(topic.id).toBe(result.body.topicId)

  const categories = await fetchJson<CategoryRow[]>("/categories")
  expect(categories.body.find((c) => c.name === "qa-autogen")?.topics[0]?.micro_summary).toBe("planning the project kickoff")

  expect(bodies).toHaveLength(2)
  expect(bodies[0]?.model).toBe("test-model-light")
  expect(bodies[0]?.messages.at(-1)?.content).toContain("plan the project kickoff")
  expect(bodies[1]?.model).toBe("test-model")
  expect(bodies[1]?.messages[0]?.content).toContain("qa-autogen / project kickoff")
})

it("reuses an existing topic matched case-insensitively by autogen", async () => {
  stubOpenRouter(["hello-reply", '{"candidates":[{"topic":"Project Kickoff","confidence":0.95}]}', "second reply"])
  const first = await chat("qa-autogen-match", "project kickoff", "hello")
  const second = await postJson<ChatResult>("/chat", { category: "qa-autogen-match", message: "more kickoff planning" })
  expect(second.status).toBe(200)
  expect(second.body.topic).toBe("project kickoff")
  expect(second.body.conversationId).toBe(first.conversationId)
})

it("falls back to the message's first words when the autogen reply is unusable", async () => {
  stubOpenRouter(["no json here, sorry", "ok"])
  const result = await postJson<ChatResult>("/chat", {
    category: "qa-autogen-fallback",
    message: "quarterly budget planning session with the team",
  })
  expect(result.status).toBe(200)
  expect(result.body.topic).toBe("quarterly budget planning session with")
})

it("generates a topic for note mode too", async () => {
  stubOpenRouter(['{"candidates":[{"topic":"meeting notes","confidence":0.95}]}', "saved"])
  const result = await postJson<ChatResult>("/chat", {
    category: "qa-notes-auto",
    message: "meeting with Anna about budgets",
    noteMode: true,
  })
  expect(result.status).toBe(200)
  expect(result.body.topic).toBe("meeting notes")
  await findTopic("qa-notes-auto", "meeting notes")
})

it("applies the confidence gate to note mode too", async () => {
  stubOpenRouter(["saved", '{"candidates":[{"topic":"meeting notes","confidence":0.4}]}'])
  await chat("qa-notes-gate", "meeting notes", "note one")

  const result = await postJson<TopicNeededResult>("/chat", { category: "qa-notes-gate", message: "another meeting note", noteMode: true })
  expect(result.status).toBe(422)
  expect(result.body.topicNeeded).toBe(true)
})

it("asks the user when topic confidence is low", async () => {
  stubOpenRouter([
    "hello",
    '{"candidates":[{"topic":"quarterly report","confidence":0.3},{"topic":"budget planning","confidence":0.25,"description":"planning budgets"}]}',
    "picked reply",
  ])
  await chat("qa-lowconf", "quarterly report", "hello")

  const result = await postJson<TopicNeededResult>("/chat", { category: "qa-lowconf", message: "some budget planning question" })
  expect(result.status).toBe(422)
  expect(result.body.topicNeeded).toBe(true)
  expect(result.body.candidates[0]).toMatchObject({ name: "quarterly report", confidence: 0.3, exists: true })
  expect(result.body.candidates[1]).toMatchObject({ name: "budget planning", confidence: 0.25, exists: false, description: "planning budgets" })

  const listed = await fetchJson<ConversationListEntry[]>("/conversations?category=qa-lowconf")
  expect(listed.body).toHaveLength(1)

  const chosen = await postJson<ChatResult>("/chat", {
    category: "qa-lowconf",
    topic: "budget planning",
    message: "some budget planning question",
  })
  expect(chosen.status).toBe(200)
  expect(chosen.body.topic).toBe("budget planning")
})

it("trims long messages for the labeling call only", async () => {
  const { bodies } = stubOpenRouter(['{"candidates":[{"topic":"long doc","confidence":0.95}]}', "ok"])
  const blob = "beginning " + "m".repeat(1300) + " ending"
  const result = await postJson<ChatResult>("/chat", { category: "qa-trim", message: blob })
  expect(result.status).toBe(200)

  const labelMessage = bodies[0]?.messages.at(-1)?.content ?? ""
  expect(labelMessage).toContain("beginning")
  expect(labelMessage).toContain("ending")
  expect(labelMessage).toContain("[...]")
  expect(labelMessage.length).toBeLessThan(1200)

  const responseMessage = bodies[1]?.messages.at(-1)?.content ?? ""
  expect(responseMessage).toBe(blob)
})

it("distills a micro summary in a separate call on fold", async () => {
  const { bodies } = stubOpenRouterByPrompt({
    "Update the summary by incorporating": "compounded context",
    "Distill the following topic summary": "one-line topic gist",
  })
  await chat("qa-micro", "t1", "hello")
  await postJson("/update-summaries")

  const topic = await findTopic("qa-micro", "t1")
  expect(topic.summary).toBe("compounded context")

  const categories = await fetchJson<CategoryRow[]>("/categories")
  expect(categories.body.find((c) => c.name === "qa-micro")?.topics[0]?.micro_summary).toBe("one-line topic gist")

  const distillCalls = bodies.filter((b) => b?.model === "test-model-light")
  expect(distillCalls.length).toBeGreaterThan(0)
})

it("backfills missing micro summaries on the next summary run", async () => {
  stubOpenRouterByPrompt({
    "Update the summary by incorporating": "compounded context",
    "Distill the following topic summary": "first gist",
  })
  await chat("qa-micro-heal", "t1", "hello")
  await postJson("/update-summaries")

  await runInDurableObject(env.ASSISTANT_DO.getByName("singleton"), (_instance, state) => {
    state.storage.sql.exec(`UPDATE topics SET micro_summary = ''`)
  })

  stubOpenRouterByPrompt({ "Distill the following topic summary": "healed gist" })
  await backdateConversations(10)
  await postJson("/update-summaries")

  const categories = await fetchJson<CategoryRow[]>("/categories")
  expect(categories.body.find((c) => c.name === "qa-micro-heal")?.topics[0]?.micro_summary).toBe("healed gist")
})

it("updates topic micro summaries manually with a derived default", async () => {
  stubOpenRouter("ok")
  await chat("qa-manual-micro", "t1", "hello")
  const topic = await findTopic("qa-manual-micro", "t1")

  await postJson("/update-summary", { type: "topic", id: topic.id, summary: "First sentence here. Second one." })
  let categories = await fetchJson<CategoryRow[]>("/categories")
  expect(categories.body.find((c) => c.name === "qa-manual-micro")?.topics[0]?.micro_summary).toBe("First sentence here.")

  await postJson("/update-summary", { type: "topic", id: topic.id, summary: "Another summary.", microSummary: "explicit micro" })
  categories = await fetchJson<CategoryRow[]>("/categories")
  expect(categories.body.find((c) => c.name === "qa-manual-micro")?.topics[0]?.micro_summary).toBe("explicit micro")
})

it("edits messages in unsummarized conversations, including assistant messages", async () => {
  stubOpenRouter("original reply")
  const first = await chat("qa-edit", "t1", "hello")

  const edited = await postJson("/update-message", { id: first.conversationId, index: 1, content: "corrected reply" })
  expect(edited.status).toBe(200)
  expect(edited.body).toEqual({ success: true })

  const detail = await fetchJson<ConversationDetail>(`/conversation?id=${first.conversationId}`)
  expect(detail.body.messages[1]?.content).toBe("corrected reply")
  expect(detail.body.messages[1]?.role).toBe("assistant")

  const listed = await fetchJson<ConversationListEntry[]>("/conversations?category=qa-edit")
  expect(listed.body[0]?.last_message).toBe("corrected reply")
})

it("edits user messages and keeps surrounding messages intact", async () => {
  stubOpenRouter("reply")
  const first = await chat("qa-edit-user", "t1", "hello")

  const edited = await postJson("/update-message", { id: first.conversationId, index: 0, content: "edited hello" })
  expect(edited.status).toBe(200)

  const detail = await fetchJson<ConversationDetail>(`/conversation?id=${first.conversationId}`)
  expect(detail.body.messages[0]).toEqual({ role: "user", content: "edited hello" })
  expect(detail.body.messages[1]?.content).toBe("reply")
})

it("deletes messages and drops the conversation when it becomes empty", async () => {
  stubOpenRouter("reply")
  const first = await chat("qa-del-msg", "t1", "hello")

  const deleted = await fetchJson(`/message?id=${first.conversationId}&index=0`, { method: "DELETE" })
  expect(deleted.status).toBe(200)

  const detail = await fetchJson<ConversationDetail>(`/conversation?id=${first.conversationId}`)
  expect(detail.body.messages).toHaveLength(1)
  expect(detail.body.messages[0]?.role).toBe("assistant")

  const deletedAgain = await fetchJson(`/message?id=${first.conversationId}&index=0`, { method: "DELETE" })
  expect(deletedAgain.status).toBe(200)

  expect((await fetchJson(`/conversation?id=${first.conversationId}`)).status).toBe(404)
})

it("rejects message mutations after the conversation is summarized", async () => {
  stubOpenRouter("ok")
  const first = await chat("qa-summarized", "t1", "hello")
  await backdateConversations(10)
  const topic = await findTopic("qa-summarized", "t1")
  await postJson("/update-summary", { type: "topic", id: topic.id, summary: "remembered" })

  const edited = await postJson("/update-message", { id: first.conversationId, index: 1, content: "too late" })
  expect(edited.status).toBe(409)
  expect(edited.body).toEqual({ error: "Message already summarized" })

  const deleted = await fetchJson(`/message?id=${first.conversationId}&index=1`, { method: "DELETE" })
  expect(deleted.status).toBe(409)
})

it("validates message mutation inputs", async () => {
  stubOpenRouter("reply")
  const first = await chat("qa-msg-validate", "t1", "hello")

  expect((await postJson("/update-message", { id: first.conversationId, index: 5, content: "nope" })).status).toBe(404)
  expect((await postJson("/update-message", { id: first.conversationId, index: 0, content: "" })).status).toBe(400)
  expect((await postJson("/update-message", { id: 424242, index: 0, content: "nope" })).status).toBe(404)
  expect((await fetchJson(`/message?id=${first.conversationId}&index=9`, { method: "DELETE" })).status).toBe(404)
  expect((await fetchJson(`/message?id=${first.conversationId}`, { method: "DELETE" })).status).toBe(400)
})