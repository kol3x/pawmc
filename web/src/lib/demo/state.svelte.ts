import { mount } from "svelte"
import { app, bindChatExecutor, type ChatExecutor } from "../appState.svelte"
import { ui } from "../uiState.svelte"
import { ApiError, toggleDemoRouterBind } from "../../api"
import type { CategorySummary, ChatMessage, ChatResponse, TopicStreamEntry, TopicSummary } from "../../api"
import DemoRoot from "../../components/demo/DemoRoot.svelte"
import { demoScript } from "./script.generated"
import type { DemoRun } from "./script-types"

/**
 * Demo runtime: the state machine over the generated script, the fake database the demo
 * router serves, and the chat executor bound into the app's send pipeline. Everything
 * lives in memory only — nothing is persisted, nothing is fetched, and the demo never
 * touches localStorage. The only way out is a page reload, which is why no state can leak.
 */

/** Fixed ids of the fake rows the router serves (mirroring the worker's SQLite rows). */
const DIARY_ID = 1
const TOPIC_ID = 11
const TOPIC2_ID = 12
const DAY1_CONVERSATION_ID = 101
const DAY2_CONVERSATION_ID = 103

/** How far day-1 history shifts back when the day passes (26h), keeping dates, relative times and the fold window coherent with real timestamps. */
const DAY_SHIFT_SECONDS = 26 * 60 * 60

/**
 * Delay before the next phase appears after a reply resolves.
 */
const ADVANCE_DELAY_MS = 500

/** Random pre-reply delay bounds in ms: day 2 sits higher — it is "reasoning" against memory. */
const REPLY_DELAY_MS = { day1: [800, 2200], day2: [1500, 3000] }

/** The phases that map to a scripted beat, in order (index = beat): three day-1 beats, then the day-2 conversation. */
const BEAT_PHASES = ["beat1", "beat2", "beat3", "day2"] as const

export type DemoPhase = (typeof BEAT_PHASES)[number] | "intro" | "dayPass" | "dayPassing" | "newConversation" | "finale" | "outro"

/** Fake conversation row mirroring the worker's conversations table. */
interface FakeConversation {
	id: number
	topicId: number
	created_at: number
	messages: ChatMessage[]
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

const epochNow = () => Math.floor(Date.now() / 1000)

/** In-memory mirror of the worker's rows; the demo router serves it in API response shapes. */
const db: {
	category: CategorySummary
	topics: TopicSummary[]
	conversations: FakeConversation[]
} = {
	category: { id: DIARY_ID, name: demoScript.diary, summary: "", updated_at_timestamp: 0, topics: [] },
	topics: [],
	conversations: [],
}

/**
 * Demo state machine: current phase, recorded picks, and the lookups the executor and
 * overlays render from.
 */
class DemoState {
	phase = $state<DemoPhase>("intro")
	/** The persona pick (option index, recorded at beat 1 — the only branch; later beats are linear). */
	picks = $state<number[]>([])
	/** True from a pick until the next beat's options appear — closes the window between the reply resolving and the phase advancing, where a second pick on the same beat would corrupt the trajectory. */
	locked = $state(false)

	/** The message drafts offered in the current phase (empty outside beat phases). Beat 1 offers the persona sketches; later beats offer the picked persona's single fixed draft. */
	currentOptions = $derived.by(() => {
		const beat = BEAT_PHASES.indexOf(this.phase as (typeof BEAT_PHASES)[number])
		if (beat < 0) return []
		if (beat === 0) return demoScript.personas
		const run = demoScript.runs[this.picks[0]]
		if (!run) return []
		if (beat === 1) return [run.beat2Message]
		if (beat === 2) return [run.beat3Message]
		return [run.day2Message]
	})

	/** Guidance for the current phase, shown above the composer's options (empty when hidden). */
	guidance = $derived.by(() => {
		switch (this.phase) {
			case "beat1":
				return "On day 1 pawmc has no context. You'd start by giving it some general info."
			case "beat2":
				return "It guessed and got part of it wrong. You correct it once and it will remember."
			case "beat3":
				return "End with a commitment. Things you confirm are saved in memory and will be thrown back at you in future conversations."
			case "dayPass":
				return "Day's done. In the real app the summarization runs nightly, so let's imagine we came back the other day."
			case "newConversation":
				return "Memory updated, you can see it on the left-hand side. Your yesterday's conversation was summarized into 'topic memory', which in turn was used to generate a higher level 'diary memory'. You can later pick diaries and topics, depending on what context you want behind your new chat. Now start a new, unrelated conversation."
			case "day2":
				return "Since it's unrelated - it will be placed under a new topic, and only get the diary memory - a higher level one. You aren't starting from zero context anymore."
			case "finale":
				return "That's it for this demonstration. Continue when you're ready."
			default:
				return ""
		}
	})

	/** Leaves the intro and starts day 1. */
	beginRun(): void {
		this.phase = "beat1"
	}

	/** Moves to the next phase once a reply has rendered, unlocking the composer. */
	advance(): void {
		const beat = BEAT_PHASES.indexOf(this.phase as (typeof BEAT_PHASES)[number])
		this.locked = false
		if (beat === 0) this.phase = "beat2"
		else if (beat === 1) this.phase = "beat3"
		else if (beat === 2) this.phase = "dayPass"
		else if (beat === 3) this.phase = "finale"
	}

	/** Leaves the finale (last reply stays readable on screen) and shows the outro screen. */
	finish(): void {
		if (this.phase !== "finale") return
		this.phase = "outro"
	}

	/** The run for the recorded persona pick. */
	currentRun(): DemoRun {
		const run = demoScript.runs[this.picks[0]]
		if (!run) throw new Error("Demo run missing for persona pick: " + this.picks.join(","))
		return run
	}

	/**
	 * Simulates the nightly fold: shifts day-1 history into the past, writes the picked
	 * run's pregenerated topic summary, micro summary and diary memory with a fresh
	 * timestamp, and reloads the shell data so the day-1 conversation folds behind its
	 * "in memory" spoiler and the memory panel fills.
	 */
	async runDayPass(): Promise<void> {
		if (this.phase !== "dayPass") return
		this.phase = "dayPassing"
		await sleep(1400)
		const run = this.currentRun()
		const now = epochNow()
		for (const conv of db.conversations) conv.created_at -= DAY_SHIFT_SECONDS
		const topic = db.topics[0]
		if (topic) {
			topic.summary = run.topicSummary
			topic.micro_summary = run.topicMicro
			topic.updated_at_timestamp = now
		}
		db.category.summary = run.categorySummary
		db.category.updated_at_timestamp = now
		await app.loadCategories()
		await app.loadStream()
		this.phase = "newConversation"
		ui.spotlightMemory = true
	}

	/**
	 * Starts the day-2 conversation: deselects the topic (the real app's new-conversation
	 * state — empty stream, no topic selected) and offers the day-2 drafts; picking one
	 * autogens topic 2 through the executor.
	 */
	startNewConversation(): void {
		if (this.phase !== "newConversation") return
		app.deselectTopic()
		this.phase = "day2"
	}
}

export const demo = new DemoState()

/**
 * Creates the fake topic 1 for a persona pick, mirroring the real autogen birth: the
 * labeler's name and one-sentence description (as the micro summary), empty summary,
 * creation timestamp — plus the day-1 conversation the run talks into.
 */
function createTopicForPick(optionIndex: number, now: number): void {
	const run = demoScript.runs[optionIndex]
	if (!run) throw new ApiError(500, "Demo topic label missing")
	db.topics = [
		{
			id: TOPIC_ID,
			name: run.topicName,
			summary: "",
			micro_summary: run.topicDescription,
			updated_at_timestamp: now,
		},
	]
	db.conversations.push({ id: DAY1_CONVERSATION_ID, topicId: TOPIC_ID, created_at: now, messages: [] })
}

/**
 * Creates the fake topic 2 for the day-2 draft, mirroring the real autogen birth in a
 * category that already has topic 1: the run's labeler name and one-sentence description
 * (as the micro summary), empty summary, creation timestamp — plus the new conversation it
 * is talked into.
 */
function createTopic2ForPick(now: number): void {
	const run = demo.currentRun()
	if (!run.topic2Name) throw new ApiError(500, "Demo topic-2 label missing")
	db.topics = [
		...db.topics,
		{
			id: TOPIC2_ID,
			name: run.topic2Name,
			summary: "",
			micro_summary: run.topic2Description ?? "",
			updated_at_timestamp: now,
		},
	]
	db.conversations.push({ id: DAY2_CONVERSATION_ID, topicId: TOPIC2_ID, created_at: now, messages: [] })
}

/**
 * Appends messages to a fake conversation row.
 */
function appendMessages(id: number, msgs: ChatMessage[]): void {
	const conv = db.conversations.find((c) => c.id === id)
	if (!conv) throw new ApiError(500, "Demo conversation missing")
	conv.messages.push(...msgs)
}

/**
 * Fresh copy of the fake category tree — api() consumers must not share object identity
 * with the demo store.
 */
function categoriesPayload(): CategorySummary[] {
	return [{ ...db.category, topics: db.topics.map((t) => ({ ...t })) }]
}

/** Fresh copy of one topic's fake conversations in the worker's GET /topic-stream shape (unknown topic names stream nothing, like the worker). */
function streamPayload(topicName: string): TopicStreamEntry[] {
	const topic = db.topics.find((t) => t.name === topicName)
	if (!topic) return []
	return db.conversations
		.filter((conv) => conv.topicId === topic.id)
		.map((conv) => ({
			id: conv.id,
			created_at: conv.created_at,
			messages: conv.messages.map((m) => ({ role: m.role, content: m.content })),
		}))
}

/**
 * Fake API bound into api(): serves the demo data in the worker's response shapes for the
 * two read routes the shell uses; every other route throws, so even a mutating affordance
 * that slips through the UI guards can never reach the network.
 */
async function demoRouter(method: string, path: string, body?: unknown): Promise<unknown> {
	void body
	const url = new URL(path, "https://demo.invalid")
	if (method === "GET" && url.pathname === "/categories") return categoriesPayload()
	if (method === "GET" && url.pathname === "/topic-stream") {
		const category = url.searchParams.get("category")
		const topic = url.searchParams.get("topic")
		if (!category || !topic) throw new ApiError(400, "Missing category or topic")
		return streamPayload(topic)
	}
	throw new ApiError(404, "Not available in the demo")
}

/**
 * Chat executor bound into the send pipeline: looks like a real /chat round-trip to
 * sendMessage. Applies the random thinking delay, mutates the fake database exactly like
 * the worker would (topic autogen + new conversation on the first day-1 message, message
 * appends afterwards, topic 2 + another conversation on day 2), then resolves the
 * pregenerated reply. Day 2 returns the new topic's id, and the real post-send refresh
 * follows the selection to it.
 */
const demoChatExecutor: ChatExecutor = async (payload): Promise<ChatResponse> => {
	const beat = BEAT_PHASES.indexOf(demo.phase as (typeof BEAT_PHASES)[number])
	if (beat < 0) throw new ApiError(409, "The demo is not expecting a message right now")
	const text = String(payload.message ?? "")
	const optionIndex = demo.currentOptions.indexOf(text)
	if (optionIndex < 0) throw new ApiError(400, "Pick one of the suggested messages")

	const isDay2 = beat === 3
	const bounds = REPLY_DELAY_MS[isDay2 ? "day2" : "day1"]
	await sleep(bounds[0] + Math.random() * (bounds[1] - bounds[0]))
	demo.locked = true

	const now = epochNow()
	if (isDay2) {
		const run = demo.currentRun()
		createTopic2ForPick(now)
		appendMessages(DAY2_CONVERSATION_ID, [
			{ role: "user", content: text },
			{ role: "assistant", content: run.day2Reply },
		])
		window.setTimeout(() => demo.advance(), ADVANCE_DELAY_MS)
		return {
			response: run.day2Reply,
			conversationId: DAY2_CONVERSATION_ID,
			topic: run.topic2Name,
			topicId: TOPIC2_ID,
		}
	}

	if (beat === 0) createTopicForPick(optionIndex, now)
	const run = beat === 0 ? demoScript.runs[optionIndex] : demo.currentRun()
	const reply = beat === 0 ? run.beat1Reply : beat === 1 ? run.beat2Reply : run.beat3Reply
	appendMessages(DAY1_CONVERSATION_ID, [
		{ role: "user", content: text },
		{ role: "assistant", content: reply },
	])
	if (beat === 0) demo.picks = [...demo.picks, optionIndex]
	window.setTimeout(() => demo.advance(), ADVANCE_DELAY_MS)
	return {
		response: reply,
		conversationId: DAY1_CONVERSATION_ID,
		topic: db.topics[0]?.name ?? "",
		topicId: TOPIC_ID,
	}
}

let demoRootEl: HTMLElement | null = null

/**
 * Mounts the demo overlay root to a dedicated element on body. Exit and restart both
 * reload the page, which removes the element and every module state with it.
 */
function mountDemoRoot(): void {
	if (demoRootEl) return
	demoRootEl = document.createElement("div")
	demoRootEl.id = "demo-root"
	document.body.appendChild(demoRootEl)
	mount(DemoRoot, { target: demoRootEl })
}

/**
 * Seeds the fake database: the empty "personal" diary, no topics, no conversations.
 */
function seedDb(): void {
	db.category.summary = ""
	db.category.updated_at_timestamp = epochNow()
	db.topics = []
	db.conversations = []
}

/**
 * Boots the demo: binds the fake router + executor, seeds the diary, drives the shell
 * through the same selection path as the real app, mounts the demo root overlay, and
 * marks the UI ready. Entry is either the auth-screen button or ?demo=1 — ui.demoActive
 * is already set by the time this runs; this only wires the demo itself.
 */
export async function startDemo(): Promise<void> {
	toggleDemoRouterBind(demoRouter)
	bindChatExecutor(demoChatExecutor)
	seedDb()
	await app.loadCategories()
	app.selectCategory(DIARY_ID)
	mountDemoRoot()
	ui.demoReady = true
	history.replaceState(null, "", `${window.location.pathname}?demo=1`)
}

/**
 * Leaves the demo: reloads the page at the bare path, dropping ?demo=1. A reload is the
 * only exit — which is also the guarantee that no demo state survives it.
 */
export function exitDemo(): void {
	window.location.replace(window.location.pathname)
}

/**
 * Restarts the demo from the intro by reloading with ?demo=1.
 */
export function restartDemo(): void {
	window.location.replace(`${window.location.pathname}?demo=1`)
}
