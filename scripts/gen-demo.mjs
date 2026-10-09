/**
 * Dual-use tool for the offline demo:
 *
 * 1. Demo generation — regenerates web/src/lib/demo/script.generated.ts by calling a real
 *    LLM through OpenRouter using pawmc's actual prompts, so demo replies, summaries and
 *    topic labels read exactly like what the deployed assistant would produce. The
 *    committed reference script was generated with the light OpenRouter model
 *    (z-ai/glm-5.3-flash), matching the AI_MODEL_OPENROUTER_LIGHT config.
 * 2. Model evaluation — the same chain doubles as the app's evaluation harness: run it
 *    with DEMO_GEN_MODEL=<OpenRouter model slug> to benchmark a candidate model against
 *    pawmc's real prompts, then compare the output against the committed reference script
 *    (`git diff web/src/lib/demo/script.generated.ts`). This is how the default Workers AI
 *    model was chosen (glm-4.7-flash and gpt-oss-120b were benchmarked against
 *    glm-5.3-flash; the 5.3 family itself is paid-tier on Workers AI).
 *
 * Structure: one onboarding run in the "personal" diary for a single developer persona
 * (drafted by hand, the Hacker News audience pick). The chain is strictly sequential —
 * every step feeds the next: verbatim autogen label, zero-context beat-1 reply, beat-2
 * reveal draft (wrapper) + reply, beat-3 commitment draft (wrapper) + reply, the three
 * fold calls over the 6-row day-1 transcript, then the day-2 thread: its own draft
 * (wrapper), verbatim label with topic 1 listed, and a verbatim reply with only the diary
 * overview as context. 12 calls, a few cents on the light model.
 *
 * Every assistant reply is a byte-verbatim /chat call — system prompt, context injection
 * and conversation shape match src/index.ts / src/ai.ts exactly. The option-authoring
 * wrapper calls have no real-prompt analog (real users type freely) and only shape the
 * user drafts.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... npm run gen:demo    real generation (overwrites the committed
 *                                              script; restore via git checkout)
 *   OPENROUTER_API_KEY=... DEMO_GEN_MODEL=<slug> npm run gen:demo
 *                                              evaluation run with another model
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

/** The real system instruction from wrangler.jsonc vars (AI_SYSTEM_INSTRUCTION). */
const AI_SYSTEM_INSTRUCTION =
	"User values succinct and direct outputs without extra formatting, warnings, and politeness."

/** The fixed demo diary name. */
const DIARY_NAME = "personal"

/** OpenRouter chat completions endpoint, as called by src/ai.ts. */
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

/**
 * Model to generate with: the light OpenRouter model (the demo reference), or any
 * OpenRouter slug via DEMO_GEN_MODEL for evaluation runs against other models.
 */
const MODEL = process.env.DEMO_GEN_MODEL || "z-ai/glm-5.3-flash"

/** Per-call retry budget for HTTP failures and schema validation misses. */
const ATTEMPTS = 3

/** Per-attempt request timeout: a stalled connection must not hang the whole run. */
const REQUEST_TIMEOUT_MS = 180_000

/** The beat-1 persona draft (hand-authored, developer-general, the Hacker News pick). */
const PERSONA =
	"I'm thirty-four, a backend developer ten years in, fully remote for the last three. My days are half coding, half meetings and reviews, and they end around six when I close the laptop upstairs. Evenings I usually drift back to a side project that has been almost done for two years, and Saturday mornings belong to the farmers market and a long bike ride."

// ---------------------------------------------------------------------------
// Verbatim replicas of the real prompt builders (src/index.ts, src/ai.ts)
// ---------------------------------------------------------------------------

/**
 * Verbatim replica of the real /chat system prompt (src/index.ts): the system instruction,
 * the assistant framing, then category/topic context when summaries exist, else the
 * no-context line the real app sends.
 */
function chatSystemPrompt(topicName, topicSummary = "", categorySummary = "") {
	const contextParts = []
	if (categorySummary) contextParts.push(`Category context: ${categorySummary}`)
	if (topicSummary) contextParts.push(`Topic context: ${topicSummary}`)
	if (!contextParts.length)
		contextParts.push(
			"You have no prior context about this topic. Ask the user about their situation if needed.",
		)
	return [
		AI_SYSTEM_INSTRUCTION,
		`You are a personal assistant helping with: ${DIARY_NAME} / ${topicName}.`,
		...contextParts,
	].join("\n")
}

/**
 * Verbatim replica of the real topic-labeling prompt (src/ai.ts resolveTopic) in both
 * branches: the demo category is empty when the day-1 first message lands; the topic-2
 * label runs with topic 1 listed by name and micro summary, exactly as resolveTopic lists.
 */
function labelerSystemPrompt(existing) {
	const listing = existing.map((t) => `- ${t.name}${t.summary ? `: ${t.summary}` : ""}`).join("\n")
	return [
		AI_SYSTEM_INSTRUCTION,
		"You label conversation topics for a personal assistant memory system.",
		existing.length
			? `Existing topics in this category:\n${listing}\n\nIf the user's message clearly belongs to one of these topics, include it with its exact name. Otherwise propose a new topic label.`
			: "There are no existing topics in this category, so propose a new topic label.",
		"A new label is short (2-5 words), specific, and recognizable by both a human and an LLM; new labels come with a one-sentence description.",
		'Reply with JSON only, up to 3 candidates, best match first: {"candidates": [{"topic": "...", "confidence": 0.0-1.0, "description": "one sentence, new labels only"}]}',
	].join("\n")
}

/**
 * Verbatim replica of the real topic fold prompt (src/index.ts updateTopicSummaryIncremental)
 * without an existing summary (the demo topic is fresh at its first fold).
 */
function topicFoldSystemPrompt(topicName) {
	return [
		AI_SYSTEM_INSTRUCTION,
		`Update the summary by incorporating the following NEW messages. Category: ${DIARY_NAME}, Topic: ${topicName}. Messages are labeled with role fields ("user" and "assistant"). Prioritize "user" messages — they represent confirmed information and intent. "assistant" messages are speculative; only include their content if the user explicitly agreed or confirmed it. Be conservative — avoid adding unconfirmed assumptions.`,
	]
		.filter(Boolean)
		.join("\n")
}

/** Verbatim replica of the real micro-summary distillation prompt (src/ai.ts distillMicroSummary). */
function microDistillSystemPrompt() {
	return [
		AI_SYSTEM_INSTRUCTION,
		"Distill the following topic summary into one short sentence description (max 15 words) that makes the topic recognizable at a glance. Reply with the sentence only, without quotes.",
	].join("\n")
}

/**
 * Verbatim replica of the real category fold prompt (src/index.ts
 * updateCategorySummaryIncremental) with the trajectory's single topic summary as input,
 * without an existing category summary.
 */
function categoryFoldSystemPrompt(topicName, topicSummary) {
	return [
		AI_SYSTEM_INSTRUCTION,
		"Update the category summary by incorporating the following UPDATED topic summaries. The category summary should provide a high-level overview, highlighting common themes and key areas of focus.",
		`Updated topic summaries:\n- ${topicName}: ${topicSummary}`,
	]
		.filter(Boolean)
		.join("\n\n")
}

// ---------------------------------------------------------------------------
// Wrapper prompts for the user-message drafts (no real-prompt analog)
// ---------------------------------------------------------------------------

/**
 * The meta-scenario injected into the option-authoring wrapper calls only. The demo is an
 * onboarding tour: a real visitor plays one fictional run by picking precomputed drafts,
 * and the drafts are written so picking one feels like answering for yourself — common,
 * everyday, relatable.
 */
const SCENARIO_SETTING =
	"The demo is an onboarding tour of a personal diary assistant: a real visitor plays one fictional run by picking precomputed message drafts, and the story follows their persona. " +
	"The visitor picked a persona in the first beat — a first-person background sketch of a life — and every later draft continues that same persona's story. " +
	"Drafts must read as something a real person could mean about themselves: situations common and relatable, the kind of thing people actually bring to a private diary — not a gimmicky self-improvement stunt, not a contrived scenario. " +
	"A real visitor picks the draft closest to what they would want to say — write each so picking it feels like answering for yourself, not watching a character."

/** Brief of the beat whose draft is being authored. */
const BEAT_BRIEFS = {
	beat2:
		"Beat: the assistant replied to the background above with zero context and guessed what the visitor needs — and got part of it wrong. " +
		"The draft reveals the real situation: it corrects that ONE misread in plain words and states what is actually going on. " +
		"Stay consistent with the persona's background; grounded and untheatrical.",
	beat3:
		"Beat: closing day one in the same conversation, the visitor makes a firm commitment about their situation. " +
		"The draft states one commitment firmly enough that tomorrow's memory can hold them to it — a concrete daily action, a deadline, or telling someone so they cannot back out, whichever fits best. " +
		"It reacts to the conversation above: the commitment must fit the actual situation discussed — do not invent people or details that were not part of it.",
	day2:
		"Beat: the next day, in a NEW conversation, the visitor writes about something from a completely DIFFERENT part of their life. " +
		"The draft must steer away from the first conversation's situation — visibly unrelated to it, not a restatement of it putting pressure on another part, not a consequence or spin-off of it. " +
		"Whatever the persona's life has beyond that situation: a thread of its own, small or large, past or future, felt or just thought about. " +
		"It stays in the persona's voice and life — do not invent facts that contradict the background.",
}

/**
 * System prompt for the option-authoring wrapper calls. These have no real-prompt analog
 * (real users type freely), so the wrapper states the scenario and the output shape.
 */
function optionsSystemPrompt(brief, count) {
	return [
		"You precompute message drafts for an offline demo of a personal diary assistant.",
		SCENARIO_SETTING,
		`Write the USER's message: ${count} draft${count === 1 ? "" : "s"} as specified by the beat brief below, each 1-3 sentences, in natural first-person diary voice. Straight quotes and plain punctuation only.`,
		`Reply with JSON only: {"options": [...]} — exactly ${count} string${count === 1 ? "" : "s"}.`,
		brief,
	].join("\n")
}

// ---------------------------------------------------------------------------
// JSON parsing and normalization helpers, replicated from src/ai.ts
// ---------------------------------------------------------------------------

/**
 * Parses a JSON object string, returning null on parse failure or non-object results.
 */
function parseJsonLoose(text) {
	try {
		const parsed = JSON.parse(text)
		return typeof parsed === "object" && parsed !== null ? parsed : null
	} catch {
		return null
	}
}

/**
 * Extracts the first JSON object from an AI reply, tolerating markdown code fences and
 * surrounding prose. Returns null when no parseable object is present.
 */
function extractJsonObject(text) {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
	for (const candidate of [fenced, text].filter(Boolean)) {
		const start = candidate.indexOf("{")
		const end = candidate.lastIndexOf("}")
		if (start < 0 || end <= start) continue
		const parsed = parseJsonLoose(candidate.slice(start, end + 1))
		if (parsed) return parsed
	}
	return null
}

/**
 * Normalizes an AI-generated topic label: collapses whitespace, strips wrapping quotes,
 * caps length. Returns empty when nothing usable remains.
 */
function sanitizeTopicLabel(raw) {
	return raw
		.replace(/\s+/g, " ")
		.replace(/^["'`\s]+|["'`\s]+$/g, "")
		.trim()
		.slice(0, 80)
}

/**
 * Normalizes a one-sentence description: collapses whitespace, strips wrapping quotes,
 * caps length. Returns empty when nothing usable remains.
 */
function sanitizeSentence(raw) {
	return raw
		.replace(/\s+/g, " ")
		.replace(/^["'`\s]+|["'`\s]+$/g, "")
		.trim()
		.slice(0, 200)
}

/**
 * Trims an oversized message for cheap calls, as the real labeler does. Demo messages are
 * short, so this passes through; replicated for fidelity.
 */
function trimForLabeling(message) {
	const HEAD = 500
	const TAIL = 500
	const THRESHOLD = 1200
	if (message.length <= THRESHOLD) return message
	return `${message.slice(0, HEAD)}\n[...]\n${message.slice(-TAIL)}`
}

// ---------------------------------------------------------------------------
// Model-output validation (hand-rolled, matching the parsing tolerances src/ai.ts uses)
// ---------------------------------------------------------------------------

/**
 * Validates and cleans the labeler's candidate list: up to 5 entries with a non-empty
 * topic and a 0-1 confidence; description kept when a non-empty string.
 */
function parseLabelerOut(raw) {
	const candidates = extractJsonObject(raw)?.candidates
	if (!Array.isArray(candidates) || !candidates.length) return null
	const clean = []
	for (const c of candidates.slice(0, 5)) {
		if (typeof c?.topic !== "string" || !c.topic.trim()) continue
		if (typeof c?.confidence !== "number" || c.confidence < 0 || c.confidence > 1) continue
		clean.push({
			topic: c.topic.trim(),
			confidence: c.confidence,
			description: typeof c?.description === "string" && c.description.trim() ? c.description.trim() : undefined,
		})
	}
	return clean.length ? { candidates: clean } : null
}

// ---------------------------------------------------------------------------
// OpenRouter client (mirrors src/ai.ts callOpenRouter: same headers; the only
// transport deviations are a per-attempt timeout so a stalled connection cannot
// hang the offline run, and throughput sort so evaluation runs do not wait on
// cheap providers — the backend itself keeps price sort, no signal)
// ---------------------------------------------------------------------------

/**
 * Sends one chat completion and returns the raw reply text. Retries on HTTP failure,
 * timeout, or an empty reply, then throws with a labeled message.
 */
async function llmText(system, conversation, label) {
	const apiKey = process.env.OPENROUTER_API_KEY
	if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set")
	const messages = [{ role: "system", content: system }, ...conversation]
	let lastError = null
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		const startedAt = Date.now()
		try {
			const resp = await fetch(OPENROUTER_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": "https://github.com/kol3x/pawmc",
					"X-Title": "pawmc",
				},
				body: JSON.stringify({ model: MODEL, messages, provider: { sort: "throughput" } }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			})
			if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
			const data = await resp.json()
			const content = data?.choices?.[0]?.message?.content
			if (!content) throw new Error("empty or unexpected response structure")
			console.log(`  [${label}] ok in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
			return content
		} catch (err) {
			lastError = err
			console.log(`  [${label}] attempt ${attempt}/${ATTEMPTS} failed: ${err.message}`)
			await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
		}
	}
	throw new Error(`[${label}] all ${ATTEMPTS} attempts failed: ${lastError?.message}`)
}

/**
 * Sends one chat completion and parses the reply through `parse`; a null return counts as
 * a schema failure and retries.
 */
async function llmParsed(system, conversation, parse, label) {
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		const raw = await llmText(system, conversation, label)
		const parsed = parse(raw)
		if (parsed) return parsed
		console.log(`  [${label}] attempt ${attempt}/${ATTEMPTS}: unusable JSON, retrying`)
	}
	throw new Error(`[${label}] could not produce valid JSON in ${ATTEMPTS} attempts`)
}

/**
 * Authors `count` user-message drafts of one beat via the wrapper prompt. `conversation`
 * carries prior turns when the drafts react to them.
 */
async function genOptions(brief, label, conversation, count) {
	return llmParsed(
		optionsSystemPrompt(brief, count),
		conversation,
		(raw) => {
			const options = extractJsonObject(raw)?.options
			if (!Array.isArray(options) || options.length !== count) return null
			const clean = options.map((o) => (typeof o === "string" ? o.trim() : ""))
			if (clean.some((o) => !o)) return null
			if (count > 1 && new Set(clean).size !== count) return null
			return clean
		},
		label,
	)
}

/**
 * Labels one first-message option with the verbatim labeler call, mirroring resolveTopic's
 * parsing and matching: candidates sorted by confidence, sanitized name and description.
 * When `existing` topics are given (the topic-2 pass), the top candidate whose name does
 * not match an existing topic wins.
 */
async function genTopicLabel(message, label, existing = []) {
	const raw = await llmText(
		labelerSystemPrompt(existing),
		[{ role: "user", content: trimForLabeling(message) }],
		label,
	)
	const parsed = parseLabelerOut(raw)
	if (!parsed || !parsed.candidates.length) {
		throw new Error(`[${label}] unusable labeler reply`)
	}
	const existingNames = new Set(existing.map((t) => t.name.toLowerCase()))
	const ranked = [...parsed.candidates].sort((a, b) => b.confidence - a.confidence)
	const top = ranked.find((c) => !existingNames.has(sanitizeTopicLabel(c.topic).toLowerCase()))
	if (!top) throw new Error(`[${label}] every candidate matched an existing topic`)
	const name = sanitizeTopicLabel(top.topic)
	if (!name) throw new Error(`[${label}] empty sanitized topic label`)
	return { name, description: top.description ? sanitizeSentence(top.description) : "" }
}

/**
 * Generates one reply with a byte-verbatim /chat-shaped call: system = real chat prompt,
 * conversation = the real turns.
 */
async function genChatReply(system, conversation, label) {
	const content = await llmText(system, conversation, label)
	return content.trim()
}

// ---------------------------------------------------------------------------
// The single-persona chain and output
// ---------------------------------------------------------------------------

/**
 * Generates the developer persona's whole run sequentially (12 calls): the verbatim
 * autogen label, the beat-1 zero-context reply, the reveal and commitment drafts authored
 * from the actual exchange so far with their verbatim replies, the three fold calls over
 * the 6-row day-1 transcript, then the day-2 thread: its own draft, verbatim label with
 * topic 1 listed, and a verbatim reply with only the diary overview as context.
 */
async function generate() {
	console.log(`Generating single-persona demo script with ${MODEL}`)

	const topic = await genTopicLabel(PERSONA, "topic-1 label")
	const beat1Reply = await genChatReply(
		chatSystemPrompt(topic.name),
		[{ role: "user", content: PERSONA }],
		"beat-1 reply",
	)
	const throughPersona = [
		{ role: "user", content: PERSONA },
		{ role: "assistant", content: beat1Reply },
	]
	const [beat2Message] = await genOptions(BEAT_BRIEFS.beat2, "beat-2 message", throughPersona, 1)
	const throughReveal = [...throughPersona, { role: "user", content: beat2Message }]
	const beat2Reply = await genChatReply(chatSystemPrompt(topic.name), throughReveal, "beat-2 reply")
	const throughRevealReply = [...throughReveal, { role: "assistant", content: beat2Reply }]
	const [beat3Message] = await genOptions(BEAT_BRIEFS.beat3, "beat-3 message", throughRevealReply, 1)
	const throughCommit = [...throughRevealReply, { role: "user", content: beat3Message }]
	const beat3Reply = await genChatReply(chatSystemPrompt(topic.name), throughCommit, "beat-3 reply")
	const day1Transcript = [...throughCommit, { role: "assistant", content: beat3Reply }]

	const topicSummary = (
		await llmText(
			topicFoldSystemPrompt(topic.name),
			[{ role: "user", content: JSON.stringify(day1Transcript) }],
			"topic fold",
		)
	).trim()
	const micro = (
		await llmText(
			microDistillSystemPrompt(),
			[{ role: "user", content: trimForLabeling(topicSummary) }],
			"micro distill",
		)
	).trim()
	const categorySummary = (
		await llmText(
			categoryFoldSystemPrompt(topic.name, topicSummary),
			[{ role: "user", content: "Generate the updated category summary." }],
			"category fold",
		)
	).trim()

	const [day2Message] = await genOptions(BEAT_BRIEFS.day2, "day-2 message", day1Transcript, 1)
	const topic2 = await genTopicLabel(day2Message, "topic-2 label", [
		{ name: topic.name, summary: micro },
	])
	const day2Reply = await genChatReply(
		chatSystemPrompt(topic2.name, "", categorySummary),
		[{ role: "user", content: day2Message }],
		"day-2 reply",
	)
	console.log("Persona chain done (12 calls)")

	const script = {
		diary: DIARY_NAME,
		personas: [PERSONA],
		runs: [
			{
				topicName: topic.name,
				topicDescription: topic.description,
				topicSummary,
				topicMicro: micro,
				categorySummary,
				beat1Reply,
				beat2Message,
				beat2Reply,
				beat3Message,
				beat3Reply,
				day2Message,
				day2Reply,
				topic2Name: topic2.name,
				topic2Description: topic2.description,
			},
		],
	}

	const outPath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"web",
		"src",
		"lib",
		"demo",
		"script.generated.ts",
	)
	const rendered = `/**
 * GENERATED by scripts/gen-demo.mjs with ${MODEL} — do not edit by hand.
 * Evaluation or regeneration run: restore the committed reference script via
 * \`git checkout web/src/lib/demo/script.generated.ts\` before shipping.
 *
 * The offline demo replays this script with no LLM and no backend: visitors pick
 * precomputed message options and read precomputed replies, summaries and topic labels.
 */
import type { DemoScript } from "./script-types"

export const demoScript: DemoScript = ${JSON.stringify(script, null, "\t")}
`
	await fs.writeFile(outPath, rendered, "utf8")
	console.log(`Wrote ${outPath}`)
}

generate().catch((err) => {
	console.error(`Demo script generation failed: ${err.message}`)
	process.exit(1)
})
