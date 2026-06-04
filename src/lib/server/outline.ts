import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { recordRevision } from './revisions';
import { chapters, outlineNodes, scenes, stories } from './db/schema';

export type OutlineNodeView = {
	id: string;
	parentId: string | null;
	title: string;
	depth: number;
	linkedSceneId: string | null;
	linkedChapterId: string | null;
};

// The story's outline as a depth-first flat list, ready for an indented
// sidebar rendering.
export async function listOutline(db: Database, storyId: string): Promise<OutlineNodeView[]> {
	const rows = await db
		.select({
			id: outlineNodes.id,
			parentId: outlineNodes.parentId,
			title: outlineNodes.title,
			linkedSceneId: outlineNodes.linkedSceneId,
			linkedChapterId: outlineNodes.linkedChapterId
		})
		.from(outlineNodes)
		.where(eq(outlineNodes.storyId, storyId))
		.orderBy(asc(outlineNodes.position), asc(outlineNodes.createdAt));

	const byParent = new Map<string | null, typeof rows>();
	for (const row of rows) {
		const siblings = byParent.get(row.parentId) ?? [];
		siblings.push(row);
		byParent.set(row.parentId, siblings);
	}
	const flat: OutlineNodeView[] = [];
	const walk = (parentId: string | null, depth: number) => {
		for (const row of byParent.get(parentId) ?? []) {
			flat.push({ ...row, depth });
			walk(row.id, depth + 1);
		}
	};
	walk(null, 0);
	return flat;
}

// Loads a node with an ownership check through its story. Everything below
// uses it, so a foreign id can never reach an update.
async function ownedNode(db: Database, nodeId: string, userId: string) {
	const [row] = await db
		.select({ node: outlineNodes, storyId: stories.id })
		.from(outlineNodes)
		.innerJoin(stories, eq(outlineNodes.storyId, stories.id))
		.where(and(eq(outlineNodes.id, nodeId), eq(stories.ownerId, userId)));
	return row?.node;
}

export async function createOutlineNode(
	db: Database,
	storyId: string,
	title: string,
	parentId: string | null = null
) {
	const [node] = await db
		.insert(outlineNodes)
		.values({
			storyId,
			parentId,
			title,
			// Computed inside the insert so concurrent creates cannot collide.
			position: sql<number>`(select coalesce(max(${outlineNodes.position}), 0) + 1 from ${outlineNodes} where ${outlineNodes.storyId} = ${storyId} and ${outlineNodes.parentId} is not distinct from ${parentId})`
		})
		.returning({ id: outlineNodes.id });
	return node;
}

export type OutlineNodeSave = {
	title: string;
	bodyMd: string;
	// One link at most: a node realises either a scene or a chapter.
	linkedSceneId?: string | null;
	linkedChapterId?: string | null;
};

export async function saveOutlineNode(
	db: Database,
	nodeId: string,
	userId: string,
	save: OutlineNodeSave
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const node = await ownedNode(db, nodeId, userId);
	if (!node) return { ok: false, reason: 'outline node not found' };
	const title = save.title.trim();
	if (!title) return { ok: false, reason: 'the node needs a title' };

	let linkedSceneId = node.linkedSceneId;
	let linkedChapterId = node.linkedChapterId;
	if (save.linkedSceneId !== undefined || save.linkedChapterId !== undefined) {
		linkedSceneId = save.linkedSceneId ?? null;
		linkedChapterId = save.linkedChapterId ?? null;
		if (linkedSceneId && linkedChapterId) {
			return { ok: false, reason: 'link the node to a scene or a chapter, not both' };
		}
		if (linkedSceneId) {
			const [scene] = await db
				.select({ id: scenes.id })
				.from(scenes)
				.where(and(eq(scenes.id, linkedSceneId), eq(scenes.storyId, node.storyId)));
			if (!scene) return { ok: false, reason: 'linked scene not found' };
		}
		if (linkedChapterId) {
			const [chapter] = await db
				.select({ id: chapters.id })
				.from(chapters)
				.where(and(eq(chapters.id, linkedChapterId), eq(chapters.storyId, node.storyId)));
			if (!chapter) return { ok: false, reason: 'linked chapter not found' };
		}
	}

	await db
		.update(outlineNodes)
		.set({ title, bodyMd: save.bodyMd, linkedSceneId, linkedChapterId })
		.where(eq(outlineNodes.id, node.id));
	await recordRevision(db, 'outline_node', node.id, save.bodyMd);
	return { ok: true };
}

// Deleting a node keeps its subtree: children are promoted to the deleted
// node's parent, appended after the existing siblings there.
export async function deleteOutlineNode(
	db: Database,
	nodeId: string,
	userId: string
): Promise<boolean> {
	const node = await ownedNode(db, nodeId, userId);
	if (!node) return false;
	await db.transaction(async (tx) => {
		await tx
			.update(outlineNodes)
			.set({
				parentId: node.parentId,
				position: sql<number>`${outlineNodes.position} + (select coalesce(max(o.position), 0) from ${outlineNodes} o where o.story_id = ${node.storyId} and o.parent_id is not distinct from ${node.parentId})`
			})
			.where(eq(outlineNodes.parentId, node.id));
		await tx.delete(outlineNodes).where(eq(outlineNodes.id, node.id));
	});
	return true;
}

// Reorders the children of one parent. The order must list exactly the
// current siblings; moves between parents go through indent and outdent.
export async function applyOutlineOrder(
	db: Database,
	storyId: string,
	parentId: string | null,
	order: string[]
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const siblings = await db
		.select({ id: outlineNodes.id })
		.from(outlineNodes)
		.where(
			and(
				eq(outlineNodes.storyId, storyId),
				parentId === null
					? sql`${outlineNodes.parentId} is null`
					: eq(outlineNodes.parentId, parentId)
			)
		);
	const siblingIds = new Set(siblings.map((row) => row.id));
	if (
		new Set(order).size !== order.length ||
		siblingIds.size !== order.length ||
		order.some((id) => !siblingIds.has(id))
	) {
		return { ok: false, reason: 'order must list each sibling exactly once' };
	}
	await db.transaction(async (tx) => {
		for (const [index, id] of order.entries()) {
			await tx
				.update(outlineNodes)
				.set({ position: index + 1 })
				.where(eq(outlineNodes.id, id));
		}
	});
	return { ok: true };
}

// Indent makes the node the last child of its previous sibling; outdent
// lifts it to just after its parent. Neither can create a cycle, since both
// move along existing tree edges.
export async function moveOutlineNode(
	db: Database,
	nodeId: string,
	userId: string,
	direction: 'indent' | 'outdent'
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const node = await ownedNode(db, nodeId, userId);
	if (!node) return { ok: false, reason: 'outline node not found' };

	if (direction === 'indent') {
		const [previous] = await db
			.select({ id: outlineNodes.id })
			.from(outlineNodes)
			.where(
				and(
					eq(outlineNodes.storyId, node.storyId),
					node.parentId === null
						? sql`${outlineNodes.parentId} is null`
						: eq(outlineNodes.parentId, node.parentId),
					sql`${outlineNodes.position} < ${node.position}`
				)
			)
			.orderBy(sql`${outlineNodes.position} desc`)
			.limit(1);
		if (!previous) return { ok: false, reason: 'nothing to indent under' };
		await db
			.update(outlineNodes)
			.set({
				parentId: previous.id,
				position: sql<number>`(select coalesce(max(o.position), 0) + 1 from ${outlineNodes} o where o.parent_id = ${previous.id})`
			})
			.where(eq(outlineNodes.id, node.id));
		return { ok: true };
	}

	if (node.parentId === null) return { ok: false, reason: 'already at the top level' };
	const [parent] = await db
		.select({
			id: outlineNodes.id,
			parentId: outlineNodes.parentId,
			position: outlineNodes.position
		})
		.from(outlineNodes)
		.where(eq(outlineNodes.id, node.parentId));
	if (!parent) return { ok: false, reason: 'outline node not found' };
	await db.transaction(async (tx) => {
		// Make room right after the parent among its siblings.
		await tx
			.update(outlineNodes)
			.set({ position: sql<number>`${outlineNodes.position} + 1` })
			.where(
				and(
					eq(outlineNodes.storyId, node.storyId),
					parent.parentId === null
						? sql`${outlineNodes.parentId} is null`
						: eq(outlineNodes.parentId, parent.parentId),
					sql`${outlineNodes.position} > ${parent.position}`
				)
			);
		await tx
			.update(outlineNodes)
			.set({ parentId: parent.parentId, position: parent.position + 1 })
			.where(eq(outlineNodes.id, node.id));
	});
	return { ok: true };
}
