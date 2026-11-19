import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	chapters,
	characters,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import {
	createChapter,
	createScene,
	deleteChapter,
	moveChapter,
	renameChapter,
	restoreScene,
	trashScene
} from '../../src/lib/server/scene-lifecycle';
import { duplicateScene, mergeScenes, splitScene } from '../../src/lib/server/scene-split-merge';
import { applySceneOrder } from '../../src/lib/server/scene-order';
import { saveSceneBody } from '../../src/lib/server/scene-save';
import { setSceneStatus } from '../../src/lib/server/scene-status';
import { rebuildSceneMentions } from '../../src/lib/server/mentions';
import { saveStoryDetails } from '../../src/lib/server/story-details';
import { trashStory } from '../../src/lib/server/story-lifecycle';
import { purgeStory } from '../../src/lib/server/story-delete';
import { saveEntity } from '../../src/lib/server/entity-save';
import { saveStoryLlmOverride } from '../../src/lib/server/llm/config';
import type { Database } from '../../src/lib/server/auth';
import { lockStoryScenes } from '../../src/lib/server/row-locks';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Finds lock-order deadlocks between write operations without having to guess
// which pairs to race. For every operation and every row it might lock, a
// holder locks the row first, so the operation stops there; while it waits,
// the rows it already holds are probed. Two such stops that each wait for a
// row the other holds, in modes that conflict, are a deadlock waiting for the
// right timing. The same stops then pause one operation while another runs,
// to catch a check made before a lock (positions read, a chapter looked up)
// going stale by the time the write lands.

process.env.APP_SECRET = process.env.APP_SECRET || 'lock-order-test-secret';

// Each scenario gets fresh ids under its own prefix, which is quicker than
// truncating between scenarios. Within one, id order differs from position
// order and from insertion order, so a lock taken in id order, in position
// order and in table-scan order each come out different.
const KEYS = {
	user: 1,
	universe: 2,
	story: 3,
	ch1: 12,
	ch2: 11,
	A: 23,
	B: 21,
	C: 24,
	D: 22,
	T: 25,
	aldric: 31
};
type Key = keyof typeof KEYS;
const S = {} as Record<Key, string>;
let scenario = 0;

const NAMES: Record<Key, string> = {
	user: 'user',
	universe: 'universe',
	story: 'story',
	ch1: 'chapter 1',
	ch2: 'chapter 2',
	A: 'scene A',
	B: 'scene B',
	C: 'scene C',
	D: 'scene D',
	T: 'trashed scene T',
	aldric: 'character Aldric'
};

// The rows a holder takes, in the tables the scene and story operations write.
const ROWS: { table: string; key: Key }[] = [
	{ table: 'users', key: 'user' },
	{ table: 'universes', key: 'universe' },
	{ table: 'stories', key: 'story' },
	{ table: 'chapters', key: 'ch1' },
	{ table: 'chapters', key: 'ch2' },
	{ table: 'scenes', key: 'A' },
	{ table: 'scenes', key: 'B' },
	{ table: 'scenes', key: 'C' },
	{ table: 'scenes', key: 'D' },
	{ table: 'scenes', key: 'T' },
	{ table: 'characters', key: 'aldric' }
];

let pool: pg.Pool;
let opPool: pg.Pool;
let db: Database;
let opDb: Database;

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	// A lock-order bug under test must fail the run, not hang it.
	opPool = new pg.Pool({
		connectionString: TEST_DATABASE_URL,
		options: '-c lock_timeout=5000'
	});
	db = drizzle(pool, { schema });
	opDb = drizzle(opPool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
	await pool.query(
		'truncate table entity_mentions, scene_markers, revisions, scenes, chapters, characters, stories, universes, users cascade'
	);
});

afterAll(async () => {
	await opPool.end();
	await pool.end();
});

async function seed() {
	scenario += 1;
	for (const [key, n] of Object.entries(KEYS))
		S[key as Key] =
			`00000000-0000-4000-8000-${String(scenario).padStart(6, '0')}${String(n).padStart(6, '0')}`;
	await db.insert(users).values({
		id: S.user,
		email: `locks${scenario}@example.com`,
		displayName: 'L',
		passwordHash: 'x',
		role: 'user'
	});
	await db.insert(universes).values({ id: S.universe, ownerId: S.user, name: 'Lockland' });
	await db
		.insert(stories)
		.values({ id: S.story, universeId: S.universe, ownerId: S.user, title: 'Turns' });
	await db.insert(chapters).values([
		{ id: S.ch1, storyId: S.story, position: 1, title: 'One' },
		{ id: S.ch2, storyId: S.story, position: 2, title: 'Two' }
	]);
	const scene = (key: Key, chapterId: string, inChapter: number, global: number) => ({
		id: S[key],
		storyId: S.story,
		chapterId,
		positionInChapter: inChapter,
		globalPosition: global,
		title: NAMES[key],
		bodyMd: `Aldric walks in. ${NAMES[key]} goes on.`
	});
	await db
		.insert(scenes)
		.values([
			scene('A', S.ch1, 1, 1),
			scene('B', S.ch1, 2, 2),
			scene('C', S.ch2, 1, 3),
			scene('D', S.ch2, 2, 4)
		]);
	await db.insert(scenes).values({ ...scene('T', S.ch2, 3, 5), deletedAt: new Date() });
	await db
		.insert(characters)
		.values({ id: S.aldric, universeId: S.universe, ownerId: S.user, name: 'Aldric' });
	for (const sceneId of [S.A, S.B, S.C, S.D]) await rebuildSceneMentions(db, sceneId);
}

type Op = { name: string; run: (db: Database) => Promise<unknown> };

const ok = (result: unknown) => {
	if (result === false || result === null) throw new Error('refused');
	if (typeof result === 'object' && result && 'ok' in result && result.ok === false)
		throw new Error(`refused: ${JSON.stringify(result)}`);
	return result;
};

const OPS: Op[] = [
	{
		name: 'save scene text',
		run: async (db) =>
			ok(
				await saveSceneBody(db, S.A, {
					title: null,
					bodyMd: 'Aldric runs out.',
					anchors: null,
					baseHashes: null,
					overwrite: false
				})
			)
	},
	{
		name: 'save scene title',
		run: async (db) =>
			ok(
				await saveSceneBody(db, S.A, {
					title: 'Renamed',
					bodyMd: `Aldric walks in. ${NAMES.A} goes on.`,
					anchors: null,
					baseHashes: null,
					overwrite: false
				})
			)
	},
	{ name: 'rebuild mentions', run: async (db) => ok(await rebuildSceneMentions(db, S.B)) },
	{
		name: 'set scene status',
		run: async (db) => ok(await setSceneStatus(db, S.user, S.A, 'final'))
	},
	{ name: 'trash scene', run: async (db) => ok(await trashScene(db, S.user, S.C)) },
	{ name: 'restore scene', run: async (db) => ok(await restoreScene(db, S.user, S.T)) },
	{ name: 'trash scene A', run: async (db) => ok(await trashScene(db, S.user, S.A)) },
	{ name: 'split scene', run: async (db) => ok(await splitScene(db, S.user, S.A, 6)) },
	{ name: 'split scene C', run: async (db) => ok(await splitScene(db, S.user, S.C, 6)) },
	{ name: 'duplicate scene', run: async (db) => ok(await duplicateScene(db, S.user, S.B)) },
	{ name: 'duplicate scene D', run: async (db) => ok(await duplicateScene(db, S.user, S.D)) },
	{
		name: 'merge scenes',
		run: async (db) => ok(await mergeScenes(db, S.user, S.story, [S.B, S.C]))
	},
	{
		name: 'merge scenes A and D',
		run: async (db) => ok(await mergeScenes(db, S.user, S.story, [S.A, S.D]))
	},
	{
		name: 'reorder scenes',
		run: async (db) =>
			ok(
				await applySceneOrder(db, S.story, {
					chapters: [
						{ id: S.ch1, sceneIds: [S.D, S.A] },
						{ id: S.ch2, sceneIds: [S.C, S.B] }
					],
					orphanSceneIds: []
				})
			)
	},
	{ name: 'create scene', run: async (db) => ok(await createScene(db, S.user, S.story, S.ch1)) },
	{
		name: 'create scene in chapter 2',
		run: async (db) => ok(await createScene(db, S.user, S.story, S.ch2))
	},
	{ name: 'create chapter', run: async (db) => ok(await createChapter(db, S.user, S.story)) },
	{ name: 'rename chapter', run: async (db) => ok(await renameChapter(db, S.user, S.ch1, 'Uno')) },
	{ name: 'move chapter', run: async (db) => ok(await moveChapter(db, S.user, S.ch2, 'up')) },
	{ name: 'delete chapter', run: async (db) => ok(await deleteChapter(db, S.user, S.ch2)) },
	{ name: 'delete chapter 1', run: async (db) => ok(await deleteChapter(db, S.user, S.ch1)) },
	{
		name: 'rename story',
		run: async (db) =>
			await saveStoryDetails(
				db,
				S.user,
				{ id: S.story, title: 'Turns', slug: 'turns' },
				{
					title: 'Other Turns',
					author: null,
					brief: null,
					descriptionMd: null,
					styleNotes: null,
					coverColor: null
				}
			)
	},
	{
		name: 'mute story for the Assistant',
		run: async (db) => await saveStoryLlmOverride(db, S.story, { enabled: false })
	},
	{ name: 'trash story', run: async (db) => ok(await trashStory(db, S.user, S.story)) },
	{ name: 'purge story', run: async (db) => await purgeStory(db, S.story) },
	{
		name: 'save character with a first story note',
		run: async (db) =>
			ok(
				await saveEntity(db, 'character', S.aldric, S.user, {
					name: 'Aldric',
					tags: ['Al'],
					summaryMd: null,
					bodyMd: '',
					storyId: S.story,
					storyNotesMd: 'Limps.'
				})
			)
	}
];

// Postgres row lock modes, weakest first, and which pairs conflict.
type Mode = 'key share' | 'share' | 'no key update' | 'update';
const MODES: Mode[] = ['key share', 'share', 'no key update', 'update'];
function conflicts(a: Mode, b: Mode): boolean {
	const [lo, hi] = [MODES.indexOf(a), MODES.indexOf(b)].sort();
	// key share only conflicts with update; share conflicts with the two
	// update modes; the update modes conflict with each other.
	if (lo === 0) return hi === 3;
	if (lo === 1) return hi >= 2;
	return true;
}

// The heavyweight tuple lock a waiter takes, by the row lock mode it wants.
const TUPLE_LOCK_MODE: Record<string, Mode> = {
	AccessShareLock: 'key share',
	RowShareLock: 'share',
	ExclusiveLock: 'no key update',
	AccessExclusiveLock: 'update'
};

// One stop of an operation: the row it waits for and every row it holds.
type Stop = { op: string; row: Key; want: string; wantMode: Mode; held: Map<string, Mode> };

// The strongest lock another transaction holds on a row, found by trying each
// mode without waiting, strongest-conflicting first.
async function heldMode(probe: pg.PoolClient, table: string, rowId: string): Promise<Mode | null> {
	const tries: [string, Mode][] = [
		['key share', 'update'],
		['share', 'no key update'],
		['no key update', 'share'],
		['update', 'key share']
	];
	for (const [lock, held] of tries) {
		try {
			await probe.query(`select 1 from ${table} where id = $1 for ${lock} nowait`, [rowId]);
		} catch (error) {
			if ((error as { code?: string }).code === '55P03') return held;
			throw error;
		}
	}
	return null;
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 10));

// Runs the operation while a holder has the row locked. When the operation
// stops on that row, `meanwhile` runs before the holder lets go. Resolves with
// whether it stopped and what it threw.
async function pausedAt(
	op: Op,
	row: { table: string; key: Key },
	meanwhile: (probe: pg.PoolClient, waiter: number) => Promise<void>
): Promise<{ stopped: boolean; failure: unknown }> {
	const holder = await pool.connect();
	const probe = await pool.connect();
	try {
		await holder.query('begin');
		await holder.query(`select 1 from ${row.table} where id = $1 for update`, [S[row.key]]);
		const holderPid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid;
		let settled = false;
		let failure: unknown = null;
		const running = op
			.run(opDb)
			.catch((error) => (failure = error))
			.finally(() => (settled = true));

		let waiter: number | null = null;
		for (let i = 0; i < 250 && !settled && waiter === null; i++) {
			const { rows } = await probe.query(
				`select pid from pg_stat_activity
				 where datname = current_database() and $1 = any(pg_blocking_pids(pid))`,
				[holderPid]
			);
			if (rows.length > 0) waiter = rows[0].pid;
			else await pause();
		}
		try {
			if (waiter !== null) await meanwhile(probe, waiter);
		} finally {
			await holder.query('rollback');
			await running;
		}
		return { stopped: waiter !== null, failure };
	} finally {
		holder.release();
		probe.release();
	}
}

async function stopsFor(op: Op): Promise<{ stops: Stop[]; failures: string[] }> {
	const stops: Stop[] = [];
	const failures: string[] = [];
	for (const row of ROWS) {
		await seed();
		const { failure } = await pausedAt(op, row, async (probe, waiter) => {
			const { rows: tuple } = await probe.query(
				`select mode from pg_locks where pid = $1 and locktype = 'tuple'`,
				[waiter]
			);
			// No tuple lock means it waits behind the holder's transaction id
			// outright, which only an update-mode request does.
			const wantMode = tuple.length > 0 ? TUPLE_LOCK_MODE[tuple[0].mode] : 'update';
			const held = new Map<string, Mode>();
			for (const other of ROWS) {
				if (other.key === row.key) continue;
				const mode = await heldMode(probe, other.table, S[other.key]);
				if (mode) held.set(NAMES[other.key], mode);
			}
			stops.push({ op: op.name, row: row.key, want: NAMES[row.key], wantMode, held });
		});
		if (failure) failures.push(`${op.name} (holding ${NAMES[row.key]}): ${failure}`);
	}
	return { stops, failures };
}

const describeHeld = (held: Map<string, Mode>) =>
	[...held].map(([row, mode]) => `${row} (${mode})`).join(', ');

// Two stops deadlock when each waits for a row the other holds, in modes that
// conflict, and nothing they both hold keeps them from being there at once.
function deadlocks(stops: Stop[]): string[] {
	const found = new Set<string>();
	for (const one of stops)
		for (const two of stops) {
			const blocks = (a: Stop, b: Stop) => {
				const mode = b.held.get(a.want);
				return mode !== undefined && conflicts(a.wantMode, mode);
			};
			if (!blocks(one, two) || !blocks(two, one)) continue;
			const together = [...one.held].every(([row, mode]) => {
				const other = two.held.get(row);
				return other === undefined || !conflicts(mode, other);
			});
			if (!together) continue;
			const pair = [one, two]
				.map(
					(stop) =>
						`${stop.op} holds ${describeHeld(stop.held)} and waits for ${stop.want} (${stop.wantMode})`
				)
				.sort();
			found.add(pair.join('; '));
		}
	return [...found].sort();
}

// What a database error says, or null for a refusal (an operation that found
// its scene gone, say), which is a fine outcome of a race.
function databaseError(error: unknown): string | null {
	if (!error) return null;
	const code =
		(error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
	return code ? `${code} ${(error as { cause?: Error }).cause?.message ?? error}` : null;
}

// Positions that two live scenes, or two chapters, share.
async function sharedPositions(): Promise<string[]> {
	const { rows } = await pool.query(
		`select 'scene' as kind, global_position::text as at from scenes
		 where story_id = $1 and deleted_at is null group by global_position having count(*) > 1
		 union all
		 select 'scene in chapter', chapter_id || ' ' || position_in_chapter from scenes
		 where story_id = $1 and deleted_at is null and chapter_id is not null
		 group by chapter_id, position_in_chapter having count(*) > 1
		 union all
		 select 'chapter', position::text from chapters
		 where story_id = $1 group by position having count(*) > 1`,
		[S.story]
	);
	return rows.map((row) => `${row.kind} position ${row.at}`);
}

// Pauses one operation at a stop, runs another to its end (or until it waits
// too), then lets the first go on. Both must finish without a database error,
// and no two scenes or chapters may end up sharing a position.
async function race(first: Op, stop: Stop, second: Op): Promise<string[]> {
	await seed();
	const row = ROWS.find((r) => r.key === stop.row)!;
	let secondFailure: unknown = null;
	let secondRun: Promise<unknown> = Promise.resolve();
	const { stopped, failure } = await pausedAt(first, row, async (probe) => {
		let settled = false;
		secondRun = second
			.run(opDb)
			.catch((error) => (secondFailure = error))
			.finally(() => (settled = true));
		for (let i = 0; i < 50 && !settled; i++) {
			const { rows } = await probe.query(
				`select count(*)::int as n from pg_stat_activity
				 where datname = current_database() and wait_event_type = 'Lock'`
			);
			if (rows[0].n > 1) break;
			await pause();
		}
	});
	await secondRun;
	if (!stopped) return [];
	const label = `${second.name} while ${first.name} waits for ${stop.want}`;
	const problems = [
		databaseError(failure) && `${label}: ${first.name} failed: ${databaseError(failure)}`,
		databaseError(secondFailure) &&
			`${label}: ${second.name} failed: ${databaseError(secondFailure)}`,
		...(await sharedPositions()).map((shared) => `${label}: ${shared} is shared`)
	];
	return problems.filter((problem): problem is string => Boolean(problem));
}

let stopsCache: Stop[] | null = null;
async function allStops(): Promise<{ stops: Stop[]; failures: string[] }> {
	const stops: Stop[] = [];
	const failures: string[] = [];
	for (const op of OPS) {
		const result = await stopsFor(op);
		stops.push(...result.stops);
		failures.push(...result.failures);
	}
	stopsCache = stops;
	return { stops, failures };
}

// The operations that add, move or remove scenes and chapters, raced against
// every stop of every operation.
const RACERS = [
	'restore scene',
	'trash scene',
	'split scene C',
	'duplicate scene',
	'merge scenes',
	'reorder scenes',
	'create scene in chapter 2',
	'create chapter',
	'move chapter',
	'delete chapter'
];

describe('lock order', () => {
	it('every operation succeeds on the seeded story', async () => {
		for (const op of OPS) {
			await seed();
			await op.run(opDb).catch((error) => {
				throw new Error(`${op.name}: ${error}`);
			});
		}
	}, 60_000);

	it('no two operations take the same rows in opposite orders', async () => {
		const { stops, failures } = await allStops();
		expect(failures).toEqual([]);
		expect(deadlocks(stops)).toEqual([]);
	}, 300_000);

	it('an operation run while another waits leaves both done and positions distinct', async () => {
		const stops = stopsCache ?? (await allStops()).stops;
		const problems: string[] = [];
		const t = Date.now();
		// Stops of one operation that hold the same rows are the same point in
		// its work for this purpose; one of each is enough. A purge only runs on
		// a trashed story, which every racer refuses, so it is not raced.
		const seen = new Set<string>();
		const points = stops.filter((stop) => {
			const at = `${stop.op}: ${[...stop.held.keys()].sort().join()}`;
			if (stop.op === 'purge story' || seen.has(at)) return false;
			seen.add(at);
			return true;
		});
		for (const stop of points) {
			const first = OPS.find((op) => op.name === stop.op)!;
			for (const name of RACERS) {
				const second = OPS.find((op) => op.name === name)!;
				problems.push(...(await race(first, stop, second)));
			}
		}
		process.stderr.write(`races ${points.length * RACERS.length} in ${Date.now() - t}ms\n`);
		expect(problems).toEqual([]);
	}, 900_000);
});

// Scene rows that are not there when a change starts waiting: a story with no
// scenes yet, and a scene another change adds while this one waits. The
// seeded races never insert while another operation waits, so these run on
// their own.
describe('lock order around scenes being added', () => {
	async function emptyStory() {
		await seed();
		await db.delete(scenes).where(eq(scenes.storyId, S.story));
	}

	// Runs `first` in a transaction that stays open until `second` waits on it
	// (or finishes), then commits it and lets `second` finish.
	async function overlap(
		first: (tx: Database) => Promise<unknown>,
		second: () => Promise<unknown>
	): Promise<unknown> {
		const holder = await pool.connect();
		const probe = await pool.connect();
		try {
			const holderPid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid;
			let secondFailure: unknown = null;
			let secondRun: Promise<unknown> = Promise.resolve();
			await drizzle(holder, { schema }).transaction(async (tx) => {
				await first(tx as unknown as Database);
				let settled = false;
				secondRun = second()
					.catch((error) => (secondFailure = error))
					.finally(() => (settled = true));
				for (let i = 0; i < 100 && !settled; i++) {
					const { rows } = await probe.query(
						`select 1 from pg_stat_activity
						 where datname = current_database() and $1 = any(pg_blocking_pids(pid))`,
						[holderPid]
					);
					if (rows.length > 0) break;
					await pause();
				}
			});
			await secondRun;
			return secondFailure;
		} finally {
			holder.release();
			probe.release();
		}
	}

	it('two scenes created at once get their own positions', async () => {
		await emptyStory();
		const failure = await overlap(
			(tx) => createScene(tx, S.user, S.story, S.ch1),
			() => createScene(opDb, S.user, S.story, S.ch1)
		);
		expect(failure).toBeNull();
		expect(await sharedPositions()).toEqual([]);
		const rows = await db.select({ id: scenes.id }).from(scenes).where(eq(scenes.storyId, S.story));
		expect(rows).toHaveLength(2);
	});

	it('a chapter deleted while a scene is created in it keeps the scene', async () => {
		await emptyStory();
		const failure = await overlap(
			(tx) => createScene(tx, S.user, S.story, S.ch1),
			() => deleteChapter(opDb, S.user, S.ch1)
		);
		expect(failure).toBeNull();
		const rows = await db
			.select({ chapterId: scenes.chapterId })
			.from(scenes)
			.where(eq(scenes.storyId, S.story));
		expect(rows).toEqual([{ chapterId: null }]);
	});

	// Otherwise a mention rebuild of the new scene, holding it while it waits
	// for the story, deadlocks with the waiter that now holds the story.
	it('a change that waited also locks the scene added meanwhile', async () => {
		await seed();
		let unlocked: string[] = [];
		const failure = await overlap(
			(tx) => duplicateScene(tx, S.user, S.B),
			() =>
				opDb.transaction(async (tx) => {
					await lockStoryScenes(tx, S.story);
					const { rows } = await pool.query(
						'select id from scenes where story_id = $1 for update skip locked',
						[S.story]
					);
					unlocked = rows.map((row) => row.id);
				})
		);
		expect(failure).toBeNull();
		expect(unlocked).toEqual([]);
	});

	// The move must read the chapter list under its lock, or it writes back a
	// position the delete just freed and leaves a gap the next create fills twice.
	it('a chapter moved while its neighbour is deleted keeps positions compact', async () => {
		await seed();
		const failure = await overlap(
			(tx) => deleteChapter(tx, S.user, S.ch2),
			() => moveChapter(opDb, S.user, S.ch1, 'down')
		);
		expect(failure).toBeNull();
		const rows = await db
			.select({ id: chapters.id, position: chapters.position })
			.from(chapters)
			.where(eq(chapters.storyId, S.story));
		expect(rows).toEqual([{ id: S.ch1, position: 1 }]);
	});
});
