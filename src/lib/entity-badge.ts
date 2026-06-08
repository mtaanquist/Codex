import { entityColor } from './entity-color';

// The per-entity badge override and how it resolves. An uploaded image wins;
// otherwise the per-entity colour, then the category colour, then a stable
// hash of the name - so an entity always has a badge, and the override is a
// single source the badge sites share.

export type BadgeFields = {
	name: string;
	badgeColor?: string | null;
	badgeAssetId?: string | null;
	categoryColor?: string | null;
};

export function badgeImageSrc(fields: { badgeAssetId?: string | null }): string | null {
	return fields.badgeAssetId ? `/assets/${fields.badgeAssetId}` : null;
}

export function badgeBackground(fields: BadgeFields): string {
	return fields.badgeColor || fields.categoryColor || entityColor(fields.name);
}
