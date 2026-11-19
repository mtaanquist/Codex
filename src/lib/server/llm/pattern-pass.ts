import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import {
	reviewComments,
	reviewThreads,
	type PatternUnitState,
	type ReviewFailure
} from '../db/schema.ts';
import { createThread, openAssistantNote } from '../review.ts';
import { assembleStoryFrame, buildSystemMessage } from './context/assemble.ts';
import {
	buildPatternApplyMessage,
	buildPatternSurveyMessage,
	mergePatterns,
	parsePatterns,
	patternNoteBody,
	PATTERN_RETRY_MESSAGE,
	splitPatternChunks,
	type FoundPattern,
	type KnownPattern,
	type PatternScene,
	type PriorNote
} from './prompts/review.ts';
import { completeDetailed, type GatewayDeps } from './gateway.ts';
import { logEvent } from '../log.ts';
import type { SpendMeter } from './spend.ts';
import type { ChatMessage } from './providers/types.ts';

// The pattern pass of a chapter or whole-story review (#1136), and its
// whole-book form (#1137). Each unit (a chapter, or the book) is surveyed for
// recurring habits in the prose, then each pattern leaves one note on the first
// scene where it shows and, scene by scene, the linked edits that fix it. The
// scene reviews that follow are handed the notes so they do not repeat them.

// The most patterns one unit reports: a chapter, and the whole book.
export const CHAPTER_PATTERN_CAP = 5;
export const BOOK_PATTERN_CAP = 8;
// An apply round stages one edit per instance in one scene.
const APPLY_TOOL_BUDGET = 32;

export type PatternUnit = {
	key: string;
	scenes: PatternScene[];
	scope: 'chapter' | 'book';
	// For the whole book: survey chapter by chapter, carrying the patterns found
	// so far forward, instead of in one request.
	chapters?: PatternScene[][];
};

export type PatternPassResult = {
	notes: number;
	failures: ReviewFailure[];
	capped: boolean;
	// The open pattern notes per scene, for the scene reviews that follow.
	prior: Map<string, PriorNote[]>;
};

type PatternState = PatternUnitState['patterns'][number];

// The names of the Assistant's open pattern notes on these scenes, so a second
// run does not report the same pattern again.
async function openPatternNames(db: Database, sceneIds: string[]): Promise<string[]> {
	if (!sceneIds.length) return [];
	const rows = await db
		.select({ body: reviewComments.bodyMd })
		.from(reviewComments)
		.innerJoin(reviewThreads, eq(reviewComments.threadId, reviewThreads.id))
		.where(
			and(
				inArray(reviewThreads.sceneId, sceneIds),
				isNull(reviewThreads.resolvedAt),
				isNull(reviewThreads.suggestionId),
				isNull(reviewThreads.anchorStart),
				eq(reviewComments.assistant, true)
			)
		)
		.orderBy(asc(reviewComments.createdAt));
	const names = rows.flatMap((row) => {
		const match = /^\s*Pattern note \(([^)]+)\)/.exec(row.body);
		return match ? [match[1].trim()] : [];
	});
	return [...new Set(names)];
}

type Request = {
	userId: string;
	storyId: string;
	system: ChatMessage | null;
	meter?: SpendMeter;
	signal?: AbortSignal;
};

// One survey request with one corrective retry. Throws when the reply is
// unreadable twice.
async function surveyOnce(
	db: Database,
	req: Request,
	content: string,
	deps: GatewayDeps
): Promise<FoundPattern[]> {
	const task: ChatMessage = { role: 'user', content };
	const messages: ChatMessage[] = req.system ? [req.system, task] : [task];
	const base = {
		userId: req.userId,
		storyId: req.storyId,
		role: 'reviewer' as const,
		meter: req.meter,
		signal: req.signal
	};
	const first = await completeDetailed(db, { ...base, messages }, deps);
	const parsed = parsePatterns(first.content);
	if (parsed) return parsed;
	// The retry repeats the text in the same first message, so a provider that
	// caches the prompt prefix reads it from cache rather than paying for it again.
	const retry = await completeDetailed(
		db,
		{
			...base,
			messages: [
				...messages,
				{ role: 'assistant', content: first.content },
				{ role: 'user', content: PATTERN_RETRY_MESSAGE }
			]
		},
		deps
	);
	const reparsed = parsePatterns(retry.content);
	if (reparsed) return reparsed;
	throw new Error(
		'The pattern search did not answer with the JSON it was asked for, twice in a row.'
	);
}

// Stage A for one unit. A chapter (or a book that fits) is surveyed in chunks
// of the budget; the book fallback goes chapter by chapter, carrying the
// patterns found so far. Returns null when the spend cap stopped it part-way.
async function surveyUnit(
	db: Database,
	req: Request & { budgetTokens: number },
	unit: PatternUnit,
	open: string[],
	deps: GatewayDeps
): Promise<FoundPattern[] | null> {
	const cap = unit.scope === 'book' ? BOOK_PATTERN_CAP : CHAPTER_PATTERN_CAP;
	const found: FoundPattern[][] = [];
	const parts = unit.chapters ?? [unit.scenes];
	for (const part of parts) {
		const known: KnownPattern[] = unit.chapters
			? mergePatterns(found).map((p) => ({ name: p.name, description: p.description }))
			: [];
		const chunks = splitPatternChunks(part, req.budgetTokens);
		for (const [i, chunk] of chunks.entries()) {
			req.signal?.throwIfAborted();
			if (req.meter?.capReached) return null;
			const content = buildPatternSurveyMessage(chunk, {
				scope: unit.scope,
				cap,
				open,
				...(known.length ? { known } : {}),
				...(chunks.length > 1 ? { chunk: { index: i + 1, total: chunks.length } } : {})
			});
			found.push(await surveyOnce(db, req, content, deps));
		}
	}
	const known = new Set(unit.scenes.map((s) => s.id));
	const openKeys = new Set(open.map((name) => name.trim().toLowerCase()));
	return mergePatterns(found)
		.map((p) => ({ ...p, sceneIds: p.sceneIds.filter((id) => known.has(id)) }))
		.filter((p) => p.sceneIds.length > 0 && !openKeys.has(p.name.trim().toLowerCase()))
		.slice(0, cap);
}

// Where a pattern's note says it shows up: the scene titles for a chapter, the
// chapter titles for the book.
function noteWhere(pattern: PatternState, unit: PatternUnit) {
	const byId = new Map(unit.scenes.map((s) => [s.id, s]));
	const scenes = pattern.sceneIds.map((id) => byId.get(id)!).filter(Boolean);
	if (unit.scope === 'book') {
		const chapters = [...new Set(scenes.map((s) => s.chapterTitle ?? 'Unfiled scenes'))];
		return { label: 'Shows up in', places: chapters };
	}
	return {
		label: 'Shows up in',
		places: scenes.map(
			(s) => (s.title ?? '').trim() || `Scene ${unit.scenes.indexOf(s) + 1} of the chapter`
		)
	};
}

// The pattern's note, on the first scene where it shows. A note already open
// with the same text (an earlier attempt of this run) is reused.
async function ensureNote(
	db: Database,
	storyId: string,
	pattern: PatternState,
	unit: PatternUnit
): Promise<boolean> {
	if (pattern.threadId) return true;
	const order = unit.scenes.map((s) => s.id);
	const first = [...pattern.sceneIds].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
	const body = patternNoteBody(pattern, noteWhere(pattern, unit));
	const created = await createThread(db, {
		storyId,
		sceneId: first,
		anchor: null,
		author: { assistant: true },
		body
	});
	const threadId = created.ok ? created.threadId : await openAssistantNote(db, first, body);
	if (!threadId) return false;
	pattern.threadId = threadId;
	pattern.noteBody = body;
	return created.ok;
}

export async function runPatternPass(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		units: PatternUnit[];
		budgetTokens: number;
		state: PatternUnitState[];
		// Persists the run state, with the notes and failures counted so far, so
		// a run that dies part-way does not lose what it already staged.
		save: (progress: { notes: number; failures: ReviewFailure[] }) => Promise<void>;
		meter?: SpendMeter;
		signal?: AbortSignal;
	},
	deps: GatewayDeps = {}
): Promise<PatternPassResult> {
	const failures: ReviewFailure[] = [];
	let notes = 0;
	let capped = false;
	// The story frame alone: the style notes the prose is judged against. The
	// text itself rides in each message.
	const frame = await assembleStoryFrame(db, {
		userId: opts.userId,
		storyId: opts.storyId,
		includeTiers: ['frame']
	});
	const system = frame ? buildSystemMessage(frame) : null;
	const req = { ...opts, system };
	const save = () => opts.save({ notes, failures });
	const bodyChars = opts.budgetTokens * 4;

	units: for (const unit of opts.units) {
		let entry = opts.state.find((s) => s.key === unit.key);
		if (!entry) {
			entry = { key: unit.key, surveyed: false, patterns: [] };
			opts.state.push(entry);
		}
		if (!entry.surveyed) {
			try {
				const open = await openPatternNames(
					db,
					unit.scenes.map((s) => s.id)
				);
				const found = await surveyUnit(db, req, unit, open, deps);
				if (!found) {
					capped = true;
					break;
				}
				entry.patterns = found.map((p) => ({ ...p, applied: [] }));
			} catch (err) {
				if (opts.signal?.aborted) throw err;
				failures.push({
					message: `The search for repeated habits failed: ${err instanceof Error ? err.message : String(err)}`
				});
				entry.patterns = [];
			}
			entry.surveyed = true;
			await save();
		}

		const byId = new Map(unit.scenes.map((s) => [s.id, s]));
		for (const pattern of entry.patterns) {
			if (!pattern.threadId) {
				try {
					if (await ensureNote(db, opts.storyId, pattern, unit)) notes += 1;
				} catch (err) {
					logEvent('error', 'assistant.patterns.note_failed', {
						storyId: opts.storyId,
						error: err instanceof Error ? err.message : String(err)
					});
				}
				if (!pattern.threadId) {
					failures.push({ message: `The note for "${pattern.name}" could not be left.` });
					// Not retried: the scenes are marked so a resumed run moves on.
					pattern.applied = [...pattern.sceneIds];
				}
				await save();
				if (!pattern.threadId) continue;
			}
			for (const sceneId of pattern.sceneIds) {
				if (pattern.applied.includes(sceneId)) continue;
				opts.signal?.throwIfAborted();
				if (opts.meter?.capReached) {
					capped = true;
					break units;
				}
				const scene = byId.get(sceneId);
				if (!scene) continue;
				const task: ChatMessage = {
					role: 'user',
					content: buildPatternApplyMessage(pattern, scene, bodyChars)
				};
				try {
					const result = await completeDetailed(
						db,
						{
							userId: opts.userId,
							storyId: opts.storyId,
							role: 'reviewer',
							enableTools: true,
							toolNames: ['suggest_edit'],
							toolBudget: APPLY_TOOL_BUDGET,
							// Edits stay in the scene being fixed.
							toolScope: {
								patternThreadId: pattern.threadId,
								editWindow: { sceneId, start: 0, end: Number.MAX_SAFE_INTEGER },
								storyOnly: true
							},
							messages: system ? [system, task] : [task],
							meter: opts.meter,
							signal: opts.signal
						},
						deps
					);
					notes += result.notes;
					if (result.stopped) {
						logEvent('info', 'assistant.patterns.stopped', {
							storyId: opts.storyId,
							stopped: result.stopped
						});
					}
				} catch (err) {
					if (opts.signal?.aborted) throw err;
					failures.push({
						sceneId,
						message: `The fixes for "${pattern.name}" could not be suggested here: ${err instanceof Error ? err.message : String(err)}`
					});
				}
				pattern.applied.push(sceneId);
				await save();
			}
		}
	}

	// The open pattern notes each scene review is handed, so it does not raise
	// the same habit as a note of its own.
	const prior = new Map<string, PriorNote[]>();
	for (const unit of opts.units) {
		const entry = opts.state.find((s) => s.key === unit.key);
		const bodies = (entry?.patterns ?? []).flatMap((p) => (p.noteBody ? [p.noteBody] : []));
		if (!bodies.length) continue;
		for (const scene of unit.scenes) {
			prior.set(scene.id, [
				...(prior.get(scene.id) ?? []),
				...bodies.map((body) => ({ kind: 'comment' as const, body }))
			]);
		}
	}
	return { notes, failures, capped, prior };
}
