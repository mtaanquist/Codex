import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import {
	chapters,
	reviewComments,
	reviewThreads,
	scenes,
	type PatternUnitState,
	type ReviewFailure
} from '../db/schema.ts';
import { createThread, openAssistantNote } from '../review.ts';
import { assembleStoryFrame, buildSystemMessage } from './context/assemble.ts';
import { estimateTokens, PERSONA_TOKENS, tokensForChars } from './context/budgets.ts';
import { roleMaxTokens, type ResolvedConfig } from './config.ts';
import { defaultMaxTokens } from '../../assistant-tuning.ts';
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
import { BOOK_PATTERN_CAP, CHAPTER_PATTERN_CAP } from './prompts/review.ts';
import { logEvent } from '../log.ts';
import type { SpendMeter } from './spend.ts';
import type { ChatMessage } from './providers/types.ts';

// The pattern pass of a chapter or whole-story review (#1136), and its
// whole-book form (#1137). Each unit (a chapter, or the book) is surveyed for
// recurring habits in the prose, then each pattern leaves one note on the first
// scene where it shows and, scene by scene, the linked edits that fix it. The
// scene reviews that follow are handed the notes so they do not repeat them.

export { BOOK_PATTERN_CAP, CHAPTER_PATTERN_CAP };
// An apply round stages one edit per instance in one scene.
const APPLY_TOOL_BUDGET = 32;
// The most scenes one pattern's fixes are suggested in, in reading order, so a
// habit that runs through a whole book does not send a request per scene of it.
export const APPLY_SCENES_PER_PATTERN = 25;

// The most fix requests the units can send: each pattern's scenes, capped.
export function maxApplyRequests(units: PatternUnit[]): number {
	return units.reduce((sum, unit) => {
		const cap = unit.scope === 'book' ? BOOK_PATTERN_CAP : CHAPTER_PATTERN_CAP;
		return sum + cap * Math.min(APPLY_SCENES_PER_PATTERN, unit.scenes.length);
	}, 0);
}

export type PatternUnit = {
	key: string;
	scenes: PatternScene[];
	scope: 'chapter' | 'book';
	// For the whole book: survey chapter by chapter, carrying the patterns found
	// so far forward, instead of in one request.
	chapters?: PatternScene[][];
	// Survey every scene in one request rather than in chunks of the budget
	// (the whole book, once it is known to fit).
	whole?: boolean;
};

// The share of the reviewer's context window the whole-book survey may fill,
// leaving the rest for the reply.
export const WHOLE_BOOK_SHARE = 0.8;

// Whether the whole book can be surveyed in one request: it fits, it must go
// chapter by chapter, or the window is unknown and the option is not offered.
export type WholeBookFit = 'fits' | 'chapters' | 'unavailable';

export function wholeBookFit(
	surveyTokens: number,
	contextWindow: number | undefined,
	replyTokens = 0
): WholeBookFit {
	if (!contextWindow) return 'unavailable';
	return surveyTokens + replyTokens <= contextWindow * WHOLE_BOOK_SHARE ? 'fits' : 'chapters';
}

// The book as one unit, its scenes in reading order under their chapter
// titles and grouped by chapter. When it fits, the survey reads it in one
// request and goes chapter by chapter only if that request fails.
export function bookPatternUnit(
	scenes: { id: string; title: string | null; bodyMd: string; chapterId: string | null }[],
	chapterTitles: Map<string, string | null>,
	fits: boolean
): PatternUnit {
	const listed = scenes.map((s) => ({
		id: s.id,
		title: s.title,
		bodyMd: s.bodyMd,
		chapterTitle: s.chapterId
			? chapterTitles.get(s.chapterId)?.trim() || 'Untitled chapter'
			: 'Unfiled scenes'
	}));
	const chapters: PatternScene[][] = [];
	scenes.forEach((scene, i) => {
		if (i === 0 || scene.chapterId !== scenes[i - 1].chapterId) chapters.push([]);
		chapters[chapters.length - 1].push(listed[i]);
	});
	return { key: 'book', scope: 'book', scenes: listed, chapters, ...(fits ? { whole: true } : {}) };
}

// The tokens the survey of these units sends: each request's text plus the
// overhead every request carries (the frame and the persona).
export function patternSurveyTokens(
	units: PatternUnit[],
	budgetTokens: number,
	overheadTokens: number
): number {
	let total = 0;
	for (const unit of units) {
		const cap = unit.scope === 'book' ? BOOK_PATTERN_CAP : CHAPTER_PATTERN_CAP;
		for (const part of unit.whole ? [unit.scenes] : (unit.chapters ?? [unit.scenes])) {
			const chunks = unit.whole ? [part] : splitPatternChunks(part, budgetTokens);
			chunks.forEach((chunk, i) => {
				total +=
					overheadTokens +
					estimateTokens(
						buildPatternSurveyMessage(chunk, {
							scope: unit.scope,
							cap,
							...(chunks.length > 1 ? { chunk: { index: i + 1, total: chunks.length } } : {})
						})
					);
			});
		}
	}
	return total;
}

// The overhead each survey request carries: the story frame the pass ships and
// an allowance for the persona.
export async function patternSurveyOverhead(
	db: Database,
	userId: string,
	storyId: string
): Promise<number> {
	const frame = await assembleStoryFrame(db, { userId, storyId, includeTiers: ['frame'] });
	return (frame ? estimateTokens(buildSystemMessage(frame).content) : 0) + PERSONA_TOKENS;
}

// The reply room a reviewer request reserves: the writer's own figure, or the
// default allowing for a model that thinks, which is the larger.
export function reviewerReplyTokens(config: ResolvedConfig, contextWindow?: number): number {
	return roleMaxTokens(config, 'reviewer') ?? defaultMaxTokens('reviewer', true, contextWindow);
}

async function chapterTitles(db: Database, storyId: string) {
	const rows = await db
		.select({ id: chapters.id, title: chapters.title })
		.from(chapters)
		.where(eq(chapters.storyId, storyId));
	return new Map(rows.map((row) => [row.id, row.title]));
}

type BookScene = { id: string; title: string | null; bodyMd: string; chapterId: string | null };

// The whole-book unit for this story's scenes, whether it fits the window with
// room for the reply, and what the survey sends either way.
export async function planBookPass(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		scenes: BookScene[];
		contextWindow: number | undefined;
		budgetTokens: number;
		replyTokens: number;
	}
): Promise<{ unit: PatternUnit; fit: WholeBookFit; tokens: number }> {
	const titles = await chapterTitles(db, opts.storyId);
	const overhead = await patternSurveyOverhead(db, opts.userId, opts.storyId);
	const whole = bookPatternUnit(opts.scenes, titles, true);
	const wholeTokens = patternSurveyTokens([whole], opts.budgetTokens, overhead);
	const fit = wholeBookFit(wholeTokens, opts.contextWindow, opts.replyTokens);
	if (fit === 'fits') return { unit: whole, fit, tokens: wholeTokens };
	const unit = bookPatternUnit(opts.scenes, titles, false);
	return { unit, fit, tokens: patternSurveyTokens([unit], opts.budgetTokens, overhead) };
}

// The fit alone, from the length of each scene rather than its text, for the
// review window's check.
export async function checkBookFit(
	db: Database,
	opts: {
		userId: string;
		storyId: string;
		scenes: (Omit<BookScene, 'bodyMd'> & { bodyChars: number })[];
		contextWindow: number | undefined;
		replyTokens: number;
	}
): Promise<WholeBookFit> {
	if (!opts.contextWindow) return 'unavailable';
	const titles = await chapterTitles(db, opts.storyId);
	const overhead = await patternSurveyOverhead(db, opts.userId, opts.storyId);
	const skeleton = bookPatternUnit(
		opts.scenes.map((s) => ({ ...s, bodyMd: '' })),
		titles,
		true
	);
	const bodies = opts.scenes.reduce((sum, s) => sum + tokensForChars(s.bodyChars), 0);
	return wholeBookFit(
		patternSurveyTokens([skeleton], 0, overhead) + bodies,
		opts.contextWindow,
		opts.replyTokens
	);
}

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
class SurveyCapped extends Error {}

async function surveyOnce(
	db: Database,
	req: Request,
	content: string,
	deps: GatewayDeps,
	askAgain = true
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
	if (!askAgain)
		throw new Error('The pattern search did not answer with the JSON it was asked for.');
	if (req.meter?.capReached) throw new SurveyCapped();
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

// How many patterns found so far a chapter survey of the book is handed: the
// most widespread, so the list stays short on a long book.
const KNOWN_CARRIED = 20;

const widestFirst = (patterns: FoundPattern[]) =>
	[...patterns].sort((a, b) => b.sceneIds.length - a.sceneIds.length);

// Surveys one part in chunks of the budget (or in one request for a book that
// fits). Throws SurveyCapped when the spend cap stopped it.
async function surveyPart(
	db: Database,
	req: Request & { budgetTokens: number },
	unit: PatternUnit,
	part: PatternScene[],
	open: string[],
	known: KnownPattern[],
	deps: GatewayDeps
): Promise<FoundPattern[]> {
	const cap = unit.scope === 'book' ? BOOK_PATTERN_CAP : CHAPTER_PATTERN_CAP;
	const chunks = unit.whole ? [part] : splitPatternChunks(part, req.budgetTokens);
	const found: FoundPattern[][] = [];
	for (const [i, chunk] of chunks.entries()) {
		req.signal?.throwIfAborted();
		if (req.meter?.capReached) throw new SurveyCapped();
		const content = buildPatternSurveyMessage(chunk, {
			scope: unit.scope,
			cap,
			open,
			...(known.length ? { known } : {}),
			...(chunks.length > 1 ? { chunk: { index: i + 1, total: chunks.length } } : {})
		});
		// The whole book is not sent a second time to ask again: an unreadable
		// reply falls back to the chapters instead.
		found.push(await surveyOnce(db, req, content, deps, !unit.whole));
	}
	return mergePatterns(found);
}

// Stage A for one unit. A chapter, or a book that fits, is one part; the book
// otherwise goes chapter by chapter, carrying the patterns found so far and
// saving after each chapter. A book that fits but whose single request fails
// falls back to the chapters. Returns null when the spend cap stopped it.
async function surveyUnit(
	db: Database,
	req: Request & { budgetTokens: number },
	unit: PatternUnit,
	entry: PatternUnitState,
	open: string[],
	failures: ReviewFailure[],
	save: () => Promise<void>,
	deps: GatewayDeps
): Promise<FoundPattern[] | null> {
	const cap = unit.scope === 'book' ? BOOK_PATTERN_CAP : CHAPTER_PATTERN_CAP;
	let found: FoundPattern[];
	try {
		if (unit.whole && !entry.partial) {
			try {
				found = await surveyPart(db, req, unit, unit.scenes, open, [], deps);
			} catch (err) {
				if (err instanceof SurveyCapped || req.signal?.aborted || !unit.chapters) throw err;
				logEvent('info', 'assistant.patterns.book_fallback', {
					storyId: req.storyId,
					error: err instanceof Error ? err.message : String(err)
				});
				return surveyUnit(db, req, { ...unit, whole: false }, entry, open, failures, save, deps);
			}
		} else if (unit.chapters) {
			const partial = (entry.partial ??= { parts: 0, found: [], sceneIds: [] });
			// A part is done when every scene in it was surveyed, so a chapter the
			// writer added, removed or moved since does not shift the count. State
			// saved before the scene ids were kept only has the count.
			const surveyed = new Set(
				partial.sceneIds ??
					unit.chapters
						.slice(0, partial.parts)
						.flat()
						.map((scene) => scene.id)
			);
			for (const [index, part] of unit.chapters.entries()) {
				if (part.every((scene) => surveyed.has(scene.id))) continue;
				const known = widestFirst(partial.found)
					.slice(0, KNOWN_CARRIED)
					.map((p) => ({ name: p.name, description: p.description }));
				try {
					const more = await surveyPart(db, req, unit, part, open, known, deps);
					partial.found = mergePatterns([partial.found, more]);
				} catch (err) {
					if (err instanceof SurveyCapped || req.signal?.aborted) throw err;
					failures.push({
						message: `The search for repeated habits skipped "${part[0]?.chapterTitle ?? 'a chapter'}": ${err instanceof Error ? err.message : String(err)}`
					});
				}
				for (const scene of part) surveyed.add(scene.id);
				partial.parts = index + 1;
				partial.sceneIds = [...surveyed];
				await save();
			}
			found = partial.found;
		} else {
			found = await surveyPart(db, req, unit, unit.scenes, open, [], deps);
		}
	} catch (err) {
		if (err instanceof SurveyCapped) return null;
		throw err;
	}
	const known = new Set(unit.scenes.map((s) => s.id));
	const openKeys = new Set(open.map((name) => name.trim().toLowerCase()));
	return widestFirst(
		found
			.map((p) => ({ ...p, sceneIds: p.sceneIds.filter((id) => known.has(id)) }))
			.filter((p) => p.sceneIds.length > 0 && !openKeys.has(p.name.trim().toLowerCase()))
	).slice(0, cap);
}

// Where a pattern's note says it shows up: the scene titles for a chapter, the
// chapter titles for the book.
function noteWhere(sceneIds: string[], unit: PatternUnit) {
	const byId = new Map(unit.scenes.map((s) => [s.id, s]));
	const scenes = sceneIds.map((id) => byId.get(id)!).filter(Boolean);
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

// The scenes a pattern shows in that this attempt read, in reading order. A
// scene deleted before it started is no place for the note or a fix.
export function patternLiveScenes(sceneIds: string[], order: string[]): string[] {
	return sceneIds
		.filter((id) => order.includes(id))
		.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

// What the note adds when the pattern shows in more scenes than get fixes.
export function fixLimitLine(liveScenes: number): string {
	return liveScenes > APPLY_SCENES_PER_PATTERN
		? `\n\nFixes are suggested in the first ${APPLY_SCENES_PER_PATTERN} of those scenes.`
		: '';
}

// Which of these scenes exist right now and have text. The unit's scenes were
// read when this attempt started, and a survey can run long after that.
async function scenesWithText(
	db: Database,
	storyId: string,
	sceneIds: string[]
): Promise<Set<string>> {
	if (!sceneIds.length) return new Set();
	const rows = await db
		.select({ id: scenes.id })
		.from(scenes)
		.where(
			and(
				inArray(scenes.id, sceneIds),
				eq(scenes.storyId, storyId),
				isNull(scenes.deletedAt),
				sql`${scenes.bodyMd} ~ '\\S'`
			)
		);
	return new Set(rows.map((row) => row.id));
}

// The pattern's note, on the first scene where it shows. A note already open
// with the same text (an earlier attempt of this run) is reused. 'gone' means
// every scene the pattern showed in was deleted or emptied since the survey,
// so there is nowhere to leave a note and nothing to fix.
async function ensureNote(
	db: Database,
	storyId: string,
	pattern: PatternState,
	unit: PatternUnit
): Promise<'created' | 'reused' | 'gone' | 'failed'> {
	if (pattern.threadId) return 'reused';
	const present = await scenesWithText(db, storyId, pattern.sceneIds);
	const live = patternLiveScenes(
		pattern.sceneIds,
		unit.scenes.map((s) => s.id)
	).filter((id) => present.has(id));
	const first = live[0];
	if (!first) return 'gone';
	const body = patternNoteBody(pattern, noteWhere(live, unit)) + fixLimitLine(live.length);
	const created = await createThread(db, {
		storyId,
		sceneId: first,
		anchor: null,
		author: { assistant: true },
		body
	});
	const threadId = created.ok ? created.threadId : await openAssistantNote(db, first, body);
	if (!threadId) return 'failed';
	pattern.threadId = threadId;
	pattern.noteBody = body;
	return created.ok ? 'created' : 'reused';
}

// A note the writer resolved or cleared since an earlier attempt of this run
// gets no more fixes and is not handed to the scene reviews.
async function dropClosedNotes(db: Database, entry: PatternUnitState): Promise<void> {
	const ids = entry.patterns.flatMap((p) => (p.threadId ? [p.threadId] : []));
	if (!ids.length) return;
	const open = await db
		.select({ id: reviewThreads.id })
		.from(reviewThreads)
		.where(and(inArray(reviewThreads.id, ids), isNull(reviewThreads.resolvedAt)));
	const live = new Set(open.map((row) => row.id));
	for (const pattern of entry.patterns) {
		if (!pattern.threadId || live.has(pattern.threadId)) continue;
		closePattern(pattern);
	}
}

async function currentScene(
	db: Database,
	storyId: string,
	sceneId: string
): Promise<{ title: string | null; bodyMd: string } | undefined> {
	const [row] = await db
		.select({ title: scenes.title, bodyMd: scenes.bodyMd })
		.from(scenes)
		.where(and(eq(scenes.id, sceneId), eq(scenes.storyId, storyId), isNull(scenes.deletedAt)));
	return row;
}

function closePattern(pattern: PatternState): void {
	pattern.applied = [...pattern.sceneIds];
	delete pattern.noteBody;
}

async function noteOpen(db: Database, threadId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: reviewThreads.id })
		.from(reviewThreads)
		.where(and(eq(reviewThreads.id, threadId), isNull(reviewThreads.resolvedAt)));
	return Boolean(row);
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
				const found = await surveyUnit(db, req, unit, entry, open, failures, save, deps);
				if (!found) {
					capped = true;
					break;
				}
				entry.patterns = found.map((p) => ({ ...p, applied: [] }));
				delete entry.partial;
				entry.surveyed = true;
			} catch (err) {
				if (opts.signal?.aborted) throw err;
				// Left unsurveyed, so a continued run tries this unit again.
				failures.push({
					message: `The search for repeated habits failed: ${err instanceof Error ? err.message : String(err)}`
				});
				entry.patterns = [];
			}
			await save();
		}

		await dropClosedNotes(db, entry);
		const byId = new Map(unit.scenes.map((s) => [s.id, s]));
		for (const pattern of entry.patterns) {
			if (!pattern.threadId) {
				let gone = false;
				try {
					const outcome = await ensureNote(db, opts.storyId, pattern, unit);
					if (outcome === 'created') notes += 1;
					gone = outcome === 'gone';
				} catch (err) {
					logEvent('error', 'assistant.patterns.note_failed', {
						storyId: opts.storyId,
						error: err instanceof Error ? err.message : String(err)
					});
				}
				if (!pattern.threadId) {
					if (!gone) {
						failures.push({ message: `The note for "${pattern.name}" could not be left.` });
					}
					// Not retried: the scenes are marked so a resumed run moves on.
					pattern.applied = [...pattern.sceneIds];
				}
				await save();
				if (!pattern.threadId) continue;
			}
			const fixIn = patternLiveScenes(
				pattern.sceneIds,
				unit.scenes.map((s) => s.id)
			);
			for (const sceneId of fixIn) {
				if (pattern.applied.includes(sceneId)) continue;
				// Only a scene that was asked about counts toward the limit, so one
				// skipped below gives its place to the next in reading order.
				if (pattern.applied.length >= APPLY_SCENES_PER_PATTERN) break;
				opts.signal?.throwIfAborted();
				if (opts.meter?.capReached) {
					capped = true;
					break units;
				}
				// The writer may resolve or clear the note while its fixes are still
				// being asked for; stop paying for a pattern nobody wants.
				if (!(await noteOpen(db, pattern.threadId))) {
					closePattern(pattern);
					await save();
					break;
				}
				// The scene as it reads now, not as it read when the run started: a
				// long run reaches a scene well after the writer may have edited it,
				// and a fix quoted from old text would be refused when staged.
				const current = await currentScene(db, opts.storyId, sceneId);
				// Deleted or emptied since this attempt read the scenes: nothing to
				// send. Left unmarked, so a run continued after the scene is restored
				// still asks about it.
				if (!current?.bodyMd.trim()) continue;
				const scene = { ...byId.get(sceneId)!, ...current };
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
