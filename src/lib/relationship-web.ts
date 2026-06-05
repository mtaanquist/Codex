// Pure graph-building and layout for the relationship web. The simulation
// runs synchronously to a settled layout (d3-force is deterministic: a
// seeded random source and a fixed initial spiral), so there is no
// animation loop to manage and tests get stable positions.
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';

export type WebEntity = {
	id: string;
	type: 'character' | 'place' | 'lore_entry';
	name: string;
	color: string | null;
};

export type WebLink = {
	id: string;
	fromId: string;
	toId: string;
	label: string;
	// Relation-type category; null groups under 'other'.
	category: string | null;
};

export type WebFilter = {
	// Empty set = all categories.
	categories?: Set<string>;
	// Limit the web to this entity and its direct connections.
	focusId?: string | null;
};

export type WebNode = WebEntity & { degree: number };

export function linkCategory(link: WebLink): string {
	return link.category ?? 'other';
}

/** The categories present in the data, in a stable order. */
export function webCategories(links: WebLink[]): string[] {
	const known = ['family', 'social', 'geography'];
	const present = new Set(links.map(linkCategory));
	return [
		...known.filter((category) => present.has(category)),
		...(present.has('other') ? ['other'] : [])
	];
}

/**
 * The filtered graph: links that pass the category and focus filters, and
 * only the entities those links touch. Isolated entities stay off the web;
 * the heatmap is the surface that shows what is unconnected.
 */
export function buildWeb(
	entities: WebEntity[],
	links: WebLink[],
	filter: WebFilter = {}
): { nodes: WebNode[]; links: WebLink[] } {
	const categories = filter.categories ?? new Set<string>();
	let kept = links.filter((link) => categories.size === 0 || categories.has(linkCategory(link)));
	if (filter.focusId) {
		kept = kept.filter((link) => link.fromId === filter.focusId || link.toId === filter.focusId);
	}
	const degree = new Map<string, number>();
	for (const link of kept) {
		degree.set(link.fromId, (degree.get(link.fromId) ?? 0) + 1);
		degree.set(link.toId, (degree.get(link.toId) ?? 0) + 1);
	}
	const nodes = entities
		.filter((entity) => degree.has(entity.id))
		.map((entity) => ({ ...entity, degree: degree.get(entity.id)! }));
	return { nodes, links: kept };
}

export type PlacedNode = WebNode & { x: number; y: number };
export type PlacedLink = WebLink & { x1: number; y1: number; x2: number; y2: number };

/** Run the force layout to rest and return positioned nodes and links. */
export function layoutWeb(
	nodes: WebNode[],
	links: WebLink[],
	width: number,
	height: number
): { nodes: PlacedNode[]; links: PlacedLink[] } {
	type SimNode = WebNode & { x?: number; y?: number; index?: number };
	const simNodes: SimNode[] = nodes.map((node) => ({ ...node }));
	const simLinks = links.map((link) => ({ source: link.fromId, target: link.toId }));
	const simulation = forceSimulation(simNodes)
		.force(
			'link',
			forceLink(simLinks)
				.id((node) => (node as SimNode).id)
				.distance(90)
		)
		.force('charge', forceManyBody().strength(-240))
		.force('x', forceX(width / 2).strength(0.06))
		.force('y', forceY(height / 2).strength(0.08))
		.force('collide', forceCollide(26))
		.stop();
	const ticks = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()));
	simulation.tick(ticks);

	// Clamp into the frame: charge can push a leaf just past the edge.
	const margin = 30;
	const placedNodes = simNodes.map((node) => ({
		...node,
		x: Math.min(width - margin, Math.max(margin, node.x ?? width / 2)),
		y: Math.min(height - margin, Math.max(margin, node.y ?? height / 2))
	}));
	const byId = new Map(placedNodes.map((node) => [node.id, node]));
	const placedLinks = links.map((link) => {
		const from = byId.get(link.fromId)!;
		const to = byId.get(link.toId)!;
		return { ...link, x1: from.x, y1: from.y, x2: to.x, y2: to.y };
	});
	return { nodes: placedNodes, links: placedLinks };
}
