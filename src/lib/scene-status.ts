// The scene status ladder, shared by the board lanes and the status endpoint.
export const SCENE_STATUSES = ['outline', 'draft', 'revised', 'final'] as const;

export type SceneStatus = (typeof SCENE_STATUSES)[number];

export const SCENE_STATUS_LABELS: Record<SceneStatus, string> = {
	outline: 'Outline',
	draft: 'Draft',
	revised: 'Revised',
	final: 'Final'
};

export function isSceneStatus(value: unknown): value is SceneStatus {
	return typeof value === 'string' && (SCENE_STATUSES as readonly string[]).includes(value);
}
