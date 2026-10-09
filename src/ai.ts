import * as z from "zod"
import { errorMessage } from "./errors"
import type { Env } from "./index"

/**
 * AI layer: provider-agnostic model calls, the OpenRouter client, and topic-label resolution. Functions take `env` (and `db` where SQL is needed) so the Durable Object remains the only stateful component.
 */

export const AiConversationEntry = z.object({
  role: z.string(),
  content: z.string(),
})

export type AiConversationEntry = z.infer<typeof AiConversationEntry>

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

const TopicCandidates = z.object({
  candidates: z
    .array(
      z.object({
        topic: z.string().trim().min(1),
        confidence: z.number().min(0).max(1),
        description: z.string().trim().optional(),
      }),
    )
    .max(5),
})

/**
 * One ranked topic proposal from the labeling call: an existing topic (canonical name, display summary, `exists`) or a new label with its one-sentence description.
 */
export interface TopicCandidate {
  name: string
  summary: string
  confidence: number
  exists: boolean
  description?: string
}

export const TOPIC_CONFIDENCE_MIN = 0.9

const LABEL_TRIM_HEAD = 500
const LABEL_TRIM_TAIL = 500
const LABEL_TRIM_THRESHOLD = 1200
const MICRO_SUMMARY_MAX = 200

/**
 * Baked-in fallbacks for the AI-related env vars that ship unconfigured: the deploy form stays minimal, and dashboard vars or secrets still override each one.
 */
const DEFAULT_WORKERS_AI_MODEL = "@cf/zai-org/glm-4.7-flash"
const DEFAULT_OPENROUTER_LIGHT_MODEL = "z-ai/glm-5.3-flash"
const DEFAULT_SYSTEM_INSTRUCTION =
  "User values succinct and direct outputs without extra formatting, warnings, and politeness."

/**
 * Resolves the AI provider: an explicit `AI_PROVIDER` override wins, otherwise the presence of an OpenRouter key selects OpenRouter and its absence falls back to Workers AI.
 */
function resolveProvider(env: Env): "workers-ai" | "openrouter" {
  const setting = env.AI_PROVIDER || (env.OPENROUTER_API_KEY ? "openrouter" : "workers-ai")
  return setting === "openrouter" ? "openrouter" : "workers-ai"
}

/**
 * Returns the configured system instruction, or the built-in default when the optional env var is absent.
 */
export function systemInstruction(env: Env): string {
  return env.AI_SYSTEM_INSTRUCTION || DEFAULT_SYSTEM_INSTRUCTION
}

/**
 * Parses a JSON object string, returning null on parse failure or non-object results.
 */
function parseJsonLoose(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Extracts the first JSON object from an AI reply, tolerating markdown code fences and surrounding prose. Returns null when no parseable object is present.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  for (const candidate of [fenced, text].filter(Boolean) as string[]) {
    const start = candidate.indexOf("{")
    const end = candidate.lastIndexOf("}")
    if (start < 0 || end <= start) continue
    const parsed = parseJsonLoose(candidate.slice(start, end + 1))
    if (parsed) return parsed
  }
  return null
}

/**
 * Normalizes an AI-generated topic label: collapses whitespace, strips wrapping quotes, caps length. Returns empty when nothing usable remains.
 */
function sanitizeTopicLabel(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .trim()
    .slice(0, 80)
}

/**
 * Derives a deterministic fallback topic label from the first words of a message, used when the AI reply cannot be parsed into a usable label.
 */
function fallbackTopicLabel(message: string): string {
  return sanitizeTopicLabel(message.split(/\s+/).slice(0, 5).join(" "))
}

/**
 * Normalizes a one-sentence description: collapses whitespace, strips wrapping quotes, caps length. Returns empty when nothing usable remains.
 */
function sanitizeSentence(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .trim()
    .slice(0, MICRO_SUMMARY_MAX)
}

/**
 * Derives a one-sentence micro summary locally as the first sentence of a summary — the zero-cost default when the distillation call fails or is skipped.
 */
export function firstSentence(text: string): string {
  return sanitizeSentence(text.split(/(?<=[.!?])\s+|\n/)[0] || "")
}

/**
 * Trims an oversized message for cheap calls: topic intent and conclusions sit at the start or finish, so pasted middle content is replaced with a marker. Short messages pass through untouched.
 */
function trimForLabeling(message: string): string {
  if (message.length <= LABEL_TRIM_THRESHOLD) return message
  return `${message.slice(0, LABEL_TRIM_HEAD)}\n[...]\n${message.slice(-LABEL_TRIM_TAIL)}`
}

/** OpenRouter provider routing order: `price` picks the cheapest provider, `throughput` the fastest. */
type OpenRouterProviderSort = "price" | "throughput"

/**
 * Runs the AI model with the given system prompt and user messages. The optional model override applies to the OpenRouter provider only, as does the optional provider sort (default price).
 */
export async function runAI(env: Env, systemPrompt: string, conversation: AiConversationEntry[], model?: string, sort?: OpenRouterProviderSort): Promise<string> {
  const messages = [{ role: "system", content: systemPrompt }, ...conversation]

  const provider = resolveProvider(env)
  const res =
    provider === "openrouter"
      ? await callOpenRouter(env, messages, model, sort)
      : await env.AI.run(env.AI_MODEL_WORKERS_AI || DEFAULT_WORKERS_AI_MODEL, {
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
 * Calls the OpenRouter API with the provided messages, routing through providers in the given order (default price: cheapest first). The optional model override selects a lighter model for cheap calls.
 */
async function callOpenRouter(env: Env, messages: AiConversationEntry[], model?: string, sort: OpenRouterProviderSort = "price"): Promise<unknown> {
  if (!env.OPENROUTER_API_KEY) throw new Error("OpenRouter is selected but OPENROUTER_API_KEY is not set.")
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/kol3x/pawmc",
      "X-Title": "pawmc",
    },
    body: JSON.stringify({
      model: model || env.AI_MODEL_OPENROUTER,
      messages,
      provider: { sort },
    }),
  })
  if (!resp.ok) throw new Error(`OpenRouter request failed: ${resp.status} ${await resp.text()}`)
  return resp.json()
}

/**
 * Runs the labeling model: the configured light OpenRouter model, or the workers-ai model when the provider is workers-ai. Labeling and distillation only need cheap classification quality. OpenRouter labeling routes by throughput since these calls sit on the interactive chat path.
 */
async function runLabeler(env: Env, systemPrompt: string, userMessage: string): Promise<string> {
  const model =
    resolveProvider(env) === "openrouter"
      ? env.AI_MODEL_OPENROUTER_LIGHT || DEFAULT_OPENROUTER_LIGHT_MODEL
      : env.AI_MODEL_WORKERS_AI || DEFAULT_WORKERS_AI_MODEL
  return runAI(env, systemPrompt, [{ role: "user", content: userMessage }], model, "throughput")
}

/**
 * Resolves a topic for a chat that started without one, via the light labeling model: the message (trimmed for this call) is matched against the category's topics — listed by name with their micro summaries — or given new short labels with one-sentence descriptions. Returns the parsed ranked candidates with `exists` flags and canonical names, or a deterministic fallback topic when the reply is unusable; callers gate on the top candidate's confidence against TOPIC_CONFIDENCE_MIN.
 */
export async function resolveTopic(
  env: Env,
  db: SqlStorage,
  categoryId: number,
  userMessage: string,
): Promise<{ topic?: string; candidates: TopicCandidate[] }> {
  const stage = "resolveTopic"
  try {
    const existing = db
      .exec(`SELECT name, summary, micro_summary FROM topics WHERE category_id = ? ORDER BY name`, categoryId)
      .toArray()
      .map((t) => ({
        name: String(t.name),
        summary: String(t.micro_summary || t.summary || ""),
      }))
    const listing = existing.map((t) => `- ${t.name}${t.summary ? `: ${t.summary}` : ""}`).join("\n")

    const systemPrompt = [
      systemInstruction(env),
      "You label conversation topics for a personal assistant memory system.",
      existing.length
        ? `Existing topics in this category:\n${listing}\n\nIf the user's message clearly belongs to one of these topics, include it with its exact name. Otherwise propose a new topic label.`
        : "There are no existing topics in this category, so propose a new topic label.",
      "A new label is short (2-5 words), specific, and recognizable by both a human and an LLM; new labels come with a one-sentence description.",
      'Reply with JSON only, up to 3 candidates, best match first: {"candidates": [{"topic": "...", "confidence": 0.0-1.0, "description": "one sentence, new labels only"}]}',
    ].join("\n")

    const raw = await runLabeler(env, systemPrompt, trimForLabeling(userMessage))
    const parsed = TopicCandidates.safeParse(extractJsonObject(raw) ?? {})

    if (!parsed.success || !parsed.data.candidates.length) {
      const fallback = fallbackTopicLabel(userMessage)
      console.log(`[INFO][${stage}] Unusable AI reply, fallback label: ${fallback}`)
      return { topic: fallback, candidates: [] }
    }

    const candidates = parsed.data.candidates
      .map((c): TopicCandidate | null => {
        const label = sanitizeTopicLabel(c.topic)
        if (!label) return null
        const match = existing.find((t) => t.name.toLowerCase() === label.toLowerCase())
        if (match) return { name: match.name, summary: match.summary, confidence: c.confidence, exists: true }
        return {
          name: label,
          summary: "",
          confidence: c.confidence,
          exists: false,
          ...(c.description ? { description: sanitizeSentence(c.description) } : {}),
        }
      })
      .filter((c): c is TopicCandidate => c !== null)
      .sort((a, b) => b.confidence - a.confidence)

    console.log(`[INFO][${stage}] Candidates: ${candidates.map((c) => `${c.name} (${c.confidence})`).join(", ")}`)
    return { candidates }
  } catch (err) {
    console.error(`[ERROR][${stage}] ${errorMessage(err)}`)
    throw err
  }
}

/**
 * Distills a topic summary into a one-sentence micro summary via the light model. Runs on the nightly fold, so latency is irrelevant. Returns empty on failure; callers fall back to the locally derived first sentence.
 */
export async function distillMicroSummary(env: Env, summary: string): Promise<string> {
  try {
    const raw = await runLabeler(
      env,
      [
        systemInstruction(env),
        "Distill the following topic summary into one short sentence description (max 15 words) that makes the topic recognizable at a glance. Reply with the sentence only, without quotes.",
      ].join("\n"),
      trimForLabeling(summary),
    )
    return sanitizeSentence(raw)
  } catch (err) {
    console.error(`[ERROR][distillMicroSummary] ${errorMessage(err)}`)
    return ""
  }
}