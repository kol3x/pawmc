/**
 * Contract of the demo script (generated once from real pawmc prompts by a throwaway
 * script, imported by the demo state).
 *
 * A run is one diary ("personal"), two topics, two days: the persona pick is the only
 * branching step — beat 1 offers the persona sketches (the current script ships one, a
 * developer persona), and each persona then follows one fixed path. Beat 2 corrects the zero-context reply's misread by revealing
 * the real situation, beat 3 commits, a day pass folds the day-1 conversation into memory,
 * then one day-2 beat starts a completely unrelated new thread — topic 2, born via the real
 * autogen labeling — whose reply has only the diary memory as context. Every user message
 * is a single precomputed draft; assistant replies are single precomputed responses, exactly
 * like the real assistant.
 */
export interface DemoScript {
	/** Fixed diary name the demo talks into. */
	diary: string
	/** Beat-1 persona drafts, shared by every run — the pick routes the whole run. */
	personas: string[]
	/** One run per persona pick, with its generated topics, summaries, drafts and replies. */
	runs: DemoRun[]
}

/** One full run — everything after the persona pick is fixed — with everything generated for it. */
export interface DemoRun {
	/** Topic 1 name from the labeling call. */
	topicName: string
	/** Topic 1 micro summary at birth: the labeler's one-sentence description, as the real autogen path stores it. */
	topicDescription: string
	/** Topic 1 summary after the day-1 fold. */
	topicSummary: string
	/** Topic 1 micro summary after the day-1 fold (the real distillation call's output). */
	topicMicro: string
	/** Diary memory after the day-1 category fold. */
	categorySummary: string
	/** The assistant's reply to the persona sketch — its zero-context guess, beat 2 corrects it. */
	beat1Reply: string
	/** Beat-2 draft: the reveal of the real situation. */
	beat2Message: string
	/** The assistant's reply to the reveal. */
	beat2Reply: string
	/** Beat-3 draft: the day-1 commitment. */
	beat3Message: string
	/** The assistant's reply to the commitment. */
	beat3Reply: string
	/** Day-2 draft: the unrelated new thread's first message. */
	day2Message: string
	/** The assistant's reply to the day-2 message — fresh topic, only the diary memory as context. */
	day2Reply: string
	/** Topic 2 name from the labeling call. */
	topic2Name: string
	/** Topic 2 micro summary at birth: the labeler's one-sentence description, as the real autogen path stores it. */
	topic2Description: string
}
