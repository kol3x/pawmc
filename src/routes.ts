import * as z from "zod"
import { errorMessage } from "./errors"
import type { Env, MutationResult } from "./index"

/**
 * HTTP layer: API-key auth and the route table. Receives every request from the worker entrypoint, resolves the singleton Durable Object stub, and maps DO results to JSON responses.
 */

const ChatRequest = z.object({
  category: z.string().trim().min(1),
  topic: z.string().trim().optional(),
  message: z.string().trim().min(1),
  noteMode: z.boolean().optional(),
})

const UpdateSummaryRequest = z.object({
  type: z.enum(["category", "topic"]),
  id: z.number().int().positive(),
  summary: z.string(),
  microSummary: z.string().trim().optional(),
})

const RenameRequest = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1),
})

const UpdateMessageRequest = z.object({
  id: z.number().int().positive(),
  index: z.number().int().min(0),
  content: z.string().trim().min(1),
})

/**
 * Parses the `id` query parameter, returning the positive integer id, or null when missing or invalid.
 */
function parseIdParam(url: URL): number | null {
  const id = Number(url.searchParams.get("id"))
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Parses a JSON request body into an unvalidated object. Returns null when the body is not valid JSON or not a JSON object; callers apply their own field checks.
 */
async function parseJsonBody(request: Request): Promise<Record<string, any> | null> {
  try {
    const body: unknown = await request.json()
    return typeof body === "object" && body !== null ? (body as Record<string, any>) : null
  } catch {
    return null
  }
}

/**
 * Maps a DO mutation result to a JSON response: ok → success, not_found → 404, name_taken or summarized → 409 with a label-specific error.
 */
function mutationResponse(result: MutationResult, label: string): Response {
  if (result.status === "ok") return Response.json({ success: true })
  if (result.status === "not_found") return Response.json({ error: `${label} not found` }, { status: 404 })
  if (result.status === "name_taken") return Response.json({ error: `${label} name already exists` }, { status: 409 })
  return Response.json({ error: `${label} already summarized` }, { status: 409 })
}

/**
 * HTTP request handler that routes requests to chat, category, conversation, and summary management endpoints. Validates API key authorization and processes GET, POST, and DELETE methods.
 */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const stage = "fetch"
  try {
    const url = new URL(request.url)
    const stub = env.ASSISTANT_DO.getByName("singleton")

    const authHeader = request.headers.get("Authorization")
    const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null
    if (!env.API_KEY) {
      return Response.json(
        { error: "API_KEY is not configured on this worker. Add it in the Cloudflare dashboard under Settings > Variables and Secrets, then reload." },
        { status: 401 },
      )
    }
    if (!apiKey || apiKey !== env.API_KEY) {
      return Response.json({ error: "Unauthorized" }, { status: 401 })
    }

    /**
     * POST /chat - Sends a message to the AI assistant and returns a response with optional context from other topics.
     */
    if (request.method === "POST" && url.pathname === "/chat") {
      const body = await parseJsonBody(request)
      if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 })
      const parsed = ChatRequest.safeParse(body)
      if (!parsed.success) return Response.json({ error: "category and message are required" }, { status: 400 })
      const { category, topic, message, noteMode } = parsed.data

      console.log(`[INFO][${stage}] Chat request: category=${category}, topic=${topic || "(autogen)"}, noteMode=${!!noteMode}`)
      const result = await stub.chat(category, topic || "", message, !!noteMode)
      if ("topicNeeded" in result) return Response.json(result, { status: 422 })
      return Response.json(result)
    }

    /**
     * GET /categories - Lists all categories with their nested topics and summaries.
     */
    if (request.method === "GET" && url.pathname === "/categories") {
      console.log(`[INFO][${stage}] Fetching categories`)
      const categories = await stub.getCategories()
      return Response.json(categories)
    }

    /**
     * GET /conversations - Lists conversations, optionally filtered by category and/or topic.
     */
    if (request.method === "GET" && url.pathname === "/conversations") {
      const category = url.searchParams.get("category") || ""
      const topic = url.searchParams.get("topic") || ""
      console.log(
        `[INFO][${stage}] Listing conversations${category ? ` category=${category}` : ""}${topic ? ` topic=${topic}` : ""}`,
      )
      const result = await stub.listConversations(category, topic)
      return Response.json(result)
    }

    /**
     * GET /topic-stream - Returns all conversations of one category/topic pair with their messages in a single response.
     */
    if (request.method === "GET" && url.pathname === "/topic-stream") {
      const category = url.searchParams.get("category") || ""
      const topic = url.searchParams.get("topic") || ""
      if (!category.trim() || !topic.trim())
        return Response.json({ error: "category and topic query parameters are required" }, { status: 400 })
      console.log(`[INFO][${stage}] Topic stream: category=${category}, topic=${topic}`)
      const result = await stub.topicConversations(category, topic)
      return Response.json(result)
    }

    /**
     * GET /conversation - Retrieves a single conversation by ID.
     */
    if (request.method === "GET" && url.pathname === "/conversation") {
      const convId = parseIdParam(url)
      if (!convId) return Response.json({ error: "id query parameter must be a positive integer" }, { status: 400 })
      console.log(`[INFO][${stage}] Fetching conversation: id=${convId}`)
      const result = await stub.getConversation(convId)
      if (!result) return Response.json({ error: "Conversation not found" }, { status: 404 })
      return Response.json(result)
    }

    /**
     * DELETE /conversation - Deletes a conversation by ID.
     */
    if (request.method === "DELETE" && url.pathname === "/conversation") {
      const convId = parseIdParam(url)
      if (!convId) return Response.json({ error: "id query parameter must be a positive integer" }, { status: 400 })
      console.log(`[INFO][${stage}] Deleting conversation: id=${convId}`)
      const result = await stub.deleteConversation(convId)
      return Response.json(result)
    }

    /**
     * POST /update-summaries - Manually triggers an update of all summaries.
     */
    if (request.method === "POST" && url.pathname === "/update-summaries") {
      console.log(`[INFO][${stage}] Manual summary update triggered`)
      await stub.updateAllSummaries()
      console.log(`[INFO][${stage}] Manual summary update completed`)
      return Response.json({ success: true })
    }

    /**
     * POST /update-summary - Updates a specific category or topic summary, with an optional micro summary for topics.
     */
    if (request.method === "POST" && url.pathname === "/update-summary") {
      const body = await parseJsonBody(request)
      if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 })
      const parsed = UpdateSummaryRequest.safeParse(body)
      if (!parsed.success) return Response.json({ error: "type, id, and summary are required" }, { status: 400 })

      const result = await stub.updateSummary(parsed.data.type, parsed.data.id, parsed.data.summary, parsed.data.microSummary)
      return Response.json(result)
    }

    /**
     * POST /rename-category - Renames a category by id.
     */
    if (request.method === "POST" && url.pathname === "/rename-category") {
      const body = await parseJsonBody(request)
      if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 })
      const parsed = RenameRequest.safeParse(body)
      if (!parsed.success) return Response.json({ error: "id and name are required" }, { status: 400 })
      console.log(`[INFO][${stage}] Rename category request: id=${parsed.data.id}, name=${parsed.data.name}`)
      return mutationResponse(await stub.renameCategory(parsed.data.id, parsed.data.name), "Category")
    }

    /**
     * POST /rename-topic - Renames a topic by id within its category.
     */
    if (request.method === "POST" && url.pathname === "/rename-topic") {
      const body = await parseJsonBody(request)
      if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 })
      const parsed = RenameRequest.safeParse(body)
      if (!parsed.success) return Response.json({ error: "id and name are required" }, { status: 400 })
      console.log(`[INFO][${stage}] Rename topic request: id=${parsed.data.id}, name=${parsed.data.name}`)
      return mutationResponse(await stub.renameTopic(parsed.data.id, parsed.data.name), "Topic")
    }

    /**
     * DELETE /category - Deletes a category by id with all of its topics and conversations.
     */
    if (request.method === "DELETE" && url.pathname === "/category") {
      const categoryId = parseIdParam(url)
      if (!categoryId) return Response.json({ error: "id query parameter must be a positive integer" }, { status: 400 })
      console.log(`[INFO][${stage}] Deleting category: id=${categoryId}`)
      return mutationResponse(await stub.deleteCategory(categoryId), "Category")
    }

    /**
     * DELETE /topic - Deletes a topic by id with all of its conversations.
     */
    if (request.method === "DELETE" && url.pathname === "/topic") {
      const topicId = parseIdParam(url)
      if (!topicId) return Response.json({ error: "id query parameter must be a positive integer" }, { status: 400 })
      console.log(`[INFO][${stage}] Deleting topic: id=${topicId}`)
      return mutationResponse(await stub.deleteTopic(topicId), "Topic")
    }

    /**
     * POST /update-message - Edits one message in an unsummarized conversation by conversation id and message index, keeping its role.
     */
    if (request.method === "POST" && url.pathname === "/update-message") {
      const body = await parseJsonBody(request)
      if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 })
      const parsed = UpdateMessageRequest.safeParse(body)
      if (!parsed.success) return Response.json({ error: "id, index, and content are required" }, { status: 400 })
      console.log(`[INFO][${stage}] Update message request: conversation=${parsed.data.id}, index=${parsed.data.index}`)
      return mutationResponse(await stub.updateMessage(parsed.data.id, parsed.data.index, parsed.data.content), "Message")
    }

    /**
     * DELETE /message - Deletes one message from an unsummarized conversation by conversation id and message index.
     */
    if (request.method === "DELETE" && url.pathname === "/message") {
      const convId = parseIdParam(url)
      const indexParam = url.searchParams.get("index")
      const index = indexParam === null ? Number.NaN : Number(indexParam)
      if (!convId || !Number.isInteger(index) || index < 0) {
        return Response.json(
          { error: "id query parameter must be a positive integer and index must be a non-negative integer" },
          { status: 400 },
        )
      }
      console.log(`[INFO][${stage}] Delete message request: conversation=${convId}, index=${index}`)
      return mutationResponse(await stub.deleteMessage(convId, index), "Message")
    }

    return Response.json({ error: "Not found" }, { status: 404 })
  } catch (err) {
    console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
    return Response.json({ error: "Internal server error" }, { status: 500 })
  }
}