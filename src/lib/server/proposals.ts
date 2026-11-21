import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import type { ActionFailure } from './action-result.ts';
import type { Database } from './auth.ts';
import {
	characters,
	entityCategories,
	entityProposals,
	loreEntries,
	places,
	sceneSplitProposals,
	scenes,
	stories,
	users
} from './db/schema.ts';
import { clientDisplayName } from '../mcp-access.ts';
import { normaliseAssistantName } from './llm/prompts/persona.ts';
import type { ClientAuthor, MachineAuthor } from './review.ts';
import { locateSplitInStory, splitScene } from './scene-split-merge.ts';
import { ownedUniverseRow, storyIsLive } from './universe-scope.ts';
import { isUniqueViolation } from './db-errors.ts';
import { locateSplitBefore } from '../scene-split-locate.ts';
import { toLf } from '../line-endings.ts';

// Things the Assistant or a connected app proposed that are not a note on a
// scene: an entry the universe may be missing, and (from an app) a scene
// split. Both wait in the universe's Suggestions until the writer decides.
// Staging creates and changes nothing of the writer's own; accepting runs the
// same create or split the app runs for the writer's own click. Every query
// is scoped to the owner.

export type ProposedKind = 'character' | 'place' | 'lore';
export const PROPOSAL_KIND_LABEL: Record<ProposedKind, string> = {
	character: 'character',
	place: 'place',
	lore: 'lore entry'
};

export const ENTITY_PROPOSAL_NAME_MAX = 120;
const DESCRIPTION_MAX = 2000;
const SEEN_IN_MAX = 500;
const RATIONALE_MAX = 1000;
// The longest opening passage a split proposal keeps.
const BEFORE_MAX = 2000;
// The most undecided proposals one program may have waiting: entries per
// universe, splits per scene. Past that it stages nothing more until the
// writer has decided on some.
export const MAX_ENTITY_PROPOSALS_WAITING = 50;
export const MAX_SPLIT_PROPOSALS_WAITING = 5;

type Staged = { ok: true; id: string } | { ok: false; reason: string };

type AppAuthor = { client: ClientAuthor };

// The app's id and its label, copied so the label outlives the client row.
function appColumns(author: AppAuthor) {
	return {
		clientId: author.client.id,
		fromName: clientDisplayName({ clientName: author.client.name, host: author.client.host })
	};
}

const folded = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

// Whether the universe already has an entry of this name, or one that lists
// it as an alias or keyword, whatever its kind. Compared without case.
async function nameTaken(db: Database, universeId: string, name: string): Promise<boolean> {
	const wanted = folded(name);
	const taken = (
		table: typeof characters | typeof places | typeof loreEntries,
		label: typeof characters.name | typeof places.name | typeof loreEntries.title,
		tags: typeof characters.aliases | typeof places.aliases | typeof loreEntries.keywords
	) =>
		db
			.select({ id: table.id })
			.from(table)
			.where(
				and(
					eq(table.universeId, universeId),
					sql`(lower(${label}) = ${wanted} or exists (select 1 from unnest(${tags}) as tag where lower(tag) = ${wanted}))`
				)
			)
			.limit(1);
	// One after another: inside a transaction they share one connection, which
	// takes one query at a time.
	const found = [
		await taken(characters, characters.name, characters.aliases),
		await taken(places, places.name, places.aliases),
		await taken(loreEntries, loreEntries.title, loreEntries.keywords)
	];
	return found.some((rows) => rows.length > 0);
}

// Stages a suggested new entry. The caller has checked the universe is the
// owner's. Refused for a name the universe already has (as a name, an alias
// or a keyword), one already waiting, and one the writer dismissed before, so
// a program that asks again and again adds nothing.
export async function stageEntityProposal(
	db: Database,
	input: {
		ownerId: string;
		universeId: string;
		kind: string;
		name: string;
		description?: string;
		seenIn?: string;
		author: MachineAuthor;
	}
): Promise<Staged> {
	if (!(input.kind in PROPOSAL_KIND_LABEL)) {
		return { ok: false, reason: 'The kind must be character, place or lore.' };
	}
	const kind = input.kind as ProposedKind;
	const name = input.name.replace(/\s+/g, ' ').trim();
	if (!name) return { ok: false, reason: 'Give the name of the entry.' };
	if (name.length > ENTITY_PROPOSAL_NAME_MAX) {
		return { ok: false, reason: 'That name is too long.' };
	}
	if (await nameTaken(db, input.universeId, name)) {
		return {
			ok: false,
			reason: `This universe already has an entry named "${name}", or one that lists it as another name. Do not suggest it again.`
		};
	}
	const earlier = await db
		.select({ status: entityProposals.status })
		.from(entityProposals)
		.where(
			and(
				eq(entityProposals.universeId, input.universeId),
				sql`lower(${entityProposals.name}) = ${folded(name)}`
			)
		);
	const waitingAlready = {
		ok: false as const,
		reason: `"${name}" is already suggested and waiting for the writer.`
	};
	if (earlier.some((row) => row.status === 'pending')) return waitingAlready;
	if (earlier.some((row) => row.status === 'dismissed')) {
		return {
			ok: false,
			reason: `The writer has turned down "${name}" before. Do not suggest it again.`
		};
	}
	const [waiting] = await db
		.select({ n: count() })
		.from(entityProposals)
		.where(
			and(
				eq(entityProposals.universeId, input.universeId),
				eq(entityProposals.status, 'pending'),
				'client' in input.author
					? eq(entityProposals.clientId, input.author.client.id)
					: eq(entityProposals.assistant, true)
			)
		);
	if (waiting.n >= MAX_ENTITY_PROPOSALS_WAITING) {
		return {
			ok: false,
			reason: `This universe already has ${waiting.n} of your suggested entries waiting for the writer. Suggest no more until they have decided on some.`
		};
	}
	try {
		// In a transaction of its own, so a refused insert does not spoil one the
		// caller is already in.
		const [row] = await db.transaction((tx) =>
			tx
				.insert(entityProposals)
				.values({
					ownerId: input.ownerId,
					universeId: input.universeId,
					kind,
					name,
					descriptionMd: input.description?.trim().slice(0, DESCRIPTION_MAX) || null,
					seenIn: input.seenIn?.trim().slice(0, SEEN_IN_MAX) || null,
					...('client' in input.author ? appColumns(input.author) : { assistant: true })
				})
				.returning({ id: entityProposals.id })
		);
		return { ok: true, id: row.id };
	} catch (err) {
		// The same name was suggested at the same moment and landed first (see
		// entity_proposals_pending_name_idx).
		if (isUniqueViolation(err)) return waitingAlready;
		throw err;
	}
}

// Stages a scene split an app proposed. The caller has checked the scene is
// the owner's and reachable, and passes its text. The opening passage must be
// found once in the scene, as the confirm will look for it.
export async function stageSplitProposal(
	db: Database,
	input: {
		ownerId: string;
		storyId: string;
		sceneId: string;
		bodyMd: string;
		before: string;
		rationale: string;
		// Only an app: in the app itself a split proposal is a card in the chat.
		author: AppAuthor;
	}
): Promise<Staged> {
	if (input.before.length > BEFORE_MAX) {
		return {
			ok: false,
			reason: 'Quote only the opening words of the new scene, not the whole of it.'
		};
	}
	const location = locateSplitBefore(toLf(input.bodyMd), toLf(input.before));
	if (!location.ok) return { ok: false, reason: location.reason };
	const mine = and(
		eq(sceneSplitProposals.sceneId, input.sceneId),
		eq(sceneSplitProposals.status, 'pending'),
		eq(sceneSplitProposals.clientId, input.author.client.id)
	);
	const open = await db
		.select({ before: sceneSplitProposals.before })
		.from(sceneSplitProposals)
		.where(mine);
	const proposedAlready = {
		ok: false as const,
		reason: 'You have already proposed this split; it is waiting for the writer.'
	};
	if (open.some((row) => row.before === input.before)) return proposedAlready;
	if (open.length >= MAX_SPLIT_PROPOSALS_WAITING) {
		return {
			ok: false,
			reason: `This scene already has ${open.length} of your split proposals waiting for the writer. Propose no more until they have decided on some.`
		};
	}
	try {
		const [row] = await db.transaction((tx) =>
			tx
				.insert(sceneSplitProposals)
				.values({
					ownerId: input.ownerId,
					storyId: input.storyId,
					sceneId: input.sceneId,
					before: input.before,
					rationale: input.rationale.trim().slice(0, RATIONALE_MAX),
					...appColumns(input.author)
				})
				.returning({ id: sceneSplitProposals.id })
		);
		return { ok: true, id: row.id };
	} catch (err) {
		// The same split, proposed at the same moment, landed first (see
		// scene_split_proposals_pending_idx).
		if (isUniqueViolation(err)) return proposedAlready;
		throw err;
	}
}

export type EntityProposalView = {
	id: string;
	kind: ProposedKind;
	name: string;
	description: string | null;
	seenIn: string | null;
	from: string;
};
export type SplitProposalView = {
	id: string;
	storyId: string;
	storyTitle: string;
	sceneId: string;
	sceneTitle: string | null;
	before: string;
	rationale: string;
	from: string;
};

async function assistantName(db: Database, ownerId: string): Promise<string> {
	const [row] = await db
		.select({ llmConfig: users.llmConfig })
		.from(users)
		.where(eq(users.id, ownerId));
	const raw = (row?.llmConfig ?? {}) as { assistantName?: unknown };
	return normaliseAssistantName(raw.assistantName) || 'Assistant';
}

// What waits for the writer in one universe, oldest first. A split proposal
// on a scene or story in the trash is not listed.
export async function listProposals(
	db: Database,
	ownerId: string,
	universeId: string
): Promise<{ entities: EntityProposalView[]; splits: SplitProposalView[] }> {
	const entityRows = await db
		.select()
		.from(entityProposals)
		.where(
			and(
				eq(entityProposals.ownerId, ownerId),
				eq(entityProposals.universeId, universeId),
				eq(entityProposals.status, 'pending')
			)
		)
		.orderBy(asc(entityProposals.createdAt));
	const splitRows = await db
		.select({
			proposal: sceneSplitProposals,
			storyTitle: stories.title,
			sceneTitle: scenes.title
		})
		.from(sceneSplitProposals)
		.innerJoin(scenes, eq(sceneSplitProposals.sceneId, scenes.id))
		.innerJoin(stories, eq(scenes.storyId, stories.id))
		.where(
			and(
				eq(sceneSplitProposals.ownerId, ownerId),
				eq(sceneSplitProposals.status, 'pending'),
				eq(stories.universeId, universeId),
				eq(stories.ownerId, ownerId),
				storyIsLive(),
				isNull(scenes.deletedAt)
			)
		)
		.orderBy(asc(sceneSplitProposals.createdAt));
	const assistant = entityRows.some((row) => row.assistant)
		? await assistantName(db, ownerId)
		: 'Assistant';
	return {
		entities: entityRows.map((row) => ({
			id: row.id,
			kind: row.kind,
			name: row.name,
			description: row.descriptionMd,
			seenIn: row.seenIn,
			from: row.assistant ? assistant : (row.fromName ?? 'A connected app')
		})),
		splits: splitRows.map(({ proposal, storyTitle, sceneTitle }) => ({
			id: proposal.id,
			// The scene's story now, which is where the split would land.
			storyId: proposal.storyId,
			storyTitle,
			sceneId: proposal.sceneId,
			sceneTitle,
			before: proposal.before,
			rationale: proposal.rationale,
			from: proposal.fromName ?? 'A connected app'
		}))
	};
}

// How many proposals wait in a universe, for the count beside its link.
export async function countProposals(
	db: Database,
	ownerId: string,
	universeId: string
): Promise<number> {
	const listed = await listProposals(db, ownerId, universeId);
	return listed.entities.length + listed.splits.length;
}

const GONE: ActionFailure = {
	ok: false,
	code: 'not_found',
	reason: 'That suggestion is no longer there.'
};

// The writer's decision on a suggested entry, made on the page of the
// universe it was suggested for: a proposal of another universe is not found,
// and nothing is decided. Accepting creates the entry in that universe as the
// Plan sidebar does (a lore entry files under the universe's first category),
// with the description as its summary.
export async function decideEntityProposal(
	db: Database,
	ownerId: string,
	universeId: string,
	proposalId: string,
	decision: 'accept' | 'dismiss'
): Promise<{ ok: true; entityId: string | null } | ActionFailure> {
	return await db.transaction(async (tx) => {
		const [proposal] = await tx
			.select()
			.from(entityProposals)
			.where(
				and(
					eq(entityProposals.id, proposalId),
					eq(entityProposals.ownerId, ownerId),
					eq(entityProposals.universeId, universeId),
					eq(entityProposals.status, 'pending')
				)
			)
			.for('update');
		if (!proposal) return GONE;
		if (!(await ownedUniverseRow(tx, ownerId, proposal.universeId))) return GONE;
		const settle = (status: 'accepted' | 'dismissed', entityId: string | null) =>
			tx
				.update(entityProposals)
				.set({ status, entityId, decidedAt: sql`now()` })
				.where(eq(entityProposals.id, proposal.id));
		if (decision === 'dismiss') {
			await settle('dismissed', null);
			return { ok: true, entityId: null };
		}
		// The name may have been taken since it was suggested.
		if (await nameTaken(tx, proposal.universeId, proposal.name)) {
			return {
				ok: false,
				code: 'conflict',
				reason: `This universe now has an entry named "${proposal.name}". Dismiss the suggestion.`
			};
		}
		const base = {
			universeId: proposal.universeId,
			ownerId,
			summaryMd: proposal.descriptionMd
		};
		let entityId: string;
		if (proposal.kind === 'character') {
			[{ id: entityId }] = await tx
				.insert(characters)
				.values({ ...base, name: proposal.name })
				.returning({ id: characters.id });
		} else if (proposal.kind === 'place') {
			[{ id: entityId }] = await tx
				.insert(places)
				.values({ ...base, name: proposal.name })
				.returning({ id: places.id });
		} else {
			const [category] = await tx
				.select({ id: entityCategories.id })
				.from(entityCategories)
				.where(eq(entityCategories.universeId, proposal.universeId))
				.orderBy(asc(entityCategories.sortOrder))
				.limit(1);
			if (!category) {
				return {
					ok: false,
					code: 'invalid',
					reason: 'Add a lore category to this universe first, then accept the entry.'
				};
			}
			[{ id: entityId }] = await tx
				.insert(loreEntries)
				.values({ ...base, categoryId: category.id, title: proposal.name })
				.returning({ id: loreEntries.id });
		}
		await settle('accepted', entityId);
		return { ok: true, entityId };
	});
}

// What the writer is told when the split point can no longer be placed. The
// locating code words its failures for the program that proposed ("include
// more surrounding text"); none of that is something the writer can act on.
const SPLIT_STALE: ActionFailure = {
	ok: false,
	code: 'conflict',
	reason:
		'The scene has changed since this was proposed, so it cannot be split here. Dismiss the proposal.'
};

// The writer's decision on a proposed split, made on the page of the universe
// its story is in: a proposal of another universe is not found, and nothing
// is decided. Confirming finds the passage in the story as it now stands (it
// may have moved to another scene) and runs the normal split; the proposal is
// settled only once the split has landed. Returns the scenes to scan for
// mentions.
export async function decideSplitProposal(
	db: Database,
	ownerId: string,
	universeId: string,
	proposalId: string,
	decision: 'confirm' | 'dismiss'
): Promise<{ ok: true; splitSceneId: string | null; newSceneId: string | null } | ActionFailure> {
	const [found] = await db
		.select({ proposal: sceneSplitProposals })
		.from(sceneSplitProposals)
		.innerJoin(stories, eq(sceneSplitProposals.storyId, stories.id))
		.where(
			and(
				eq(sceneSplitProposals.id, proposalId),
				eq(sceneSplitProposals.ownerId, ownerId),
				eq(sceneSplitProposals.status, 'pending'),
				eq(stories.universeId, universeId),
				eq(stories.ownerId, ownerId)
			)
		);
	if (!found) return GONE;
	const { proposal } = found;
	const settle = (status: 'confirmed' | 'dismissed') =>
		db
			.update(sceneSplitProposals)
			.set({ status, decidedAt: sql`now()` })
			.where(
				and(eq(sceneSplitProposals.id, proposal.id), eq(sceneSplitProposals.status, 'pending'))
			)
			.returning({ id: sceneSplitProposals.id });
	if (decision === 'dismiss') {
		await settle('dismissed');
		return { ok: true, splitSceneId: null, newSceneId: null };
	}
	const location = await locateSplitInStory(db, ownerId, proposal.sceneId, proposal.before);
	// The locate follows a passage into another scene of the story, which suits
	// the Assistant's chain of splits in one chat. The writer was shown this
	// proposal on one scene, so only that scene is split.
	if (!location.ok || location.sceneId !== proposal.sceneId) return SPLIT_STALE;
	// Settled first, so two confirms of one proposal cannot both split; put
	// back if the split itself is refused.
	const [claimed] = await settle('confirmed');
	if (!claimed) return GONE;
	const result = await splitScene(
		db,
		ownerId,
		location.sceneId,
		location.offset,
		location.baseHash
	);
	if (!result.ok) {
		await db
			.update(sceneSplitProposals)
			.set({ status: 'pending', decidedAt: null })
			.where(eq(sceneSplitProposals.id, proposal.id));
		return result;
	}
	return { ok: true, splitSceneId: location.sceneId, newSceneId: result.newSceneId };
}
