import { env, exports } from "cloudflare:workers"
import { createExecutionContext, createScheduledController, runInDurableObject } from "cloudflare:test"
import { afterEach, expect, it, vi } from "vitest"
import worker, {
  type CategoryRow,
  type ChatResult,
  type ConversationDetail,
  type ConversationListEntry,
  type Env,
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

async function backdateConversations(seconds: number): Promise<void> {
  await runInDurableObject(env.ASSISTANT_DO.getByName("singleton"), (_instance, state) => {
    state.storage.sql.exec(`UPDATE conversations SET created_at_timestamp = created_at_timestamp - ?`, seconds)
  })
}

function stubOpenRouter(content: string): { bodies: Array<{ messages: Array<{ role: string; content: string }> }> } {
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const original = globalThis.fetch
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === OPENROUTER_URL) {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null)
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
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
