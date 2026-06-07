// Pure aggregation helpers behind the universe Insights view. Day strings are
// ISO dates (YYYY-MM-DD) already resolved to the author's timezone; all the
// date arithmetic here is calendar-day maths on those strings.

export type SceneDayWords = {
	sceneId: string;
	day: string;
	// Word count of the scene at the end of that day.
	words: number;
};

export type DailyWords = { day: string; words: number };

function toUtcMs(day: string): number {
	const [year, month, date] = day.split('-').map(Number);
	return Date.UTC(year, month - 1, date);
}

function fromUtcMs(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(day: string, days: number): string {
	return fromUtcMs(toUtcMs(day) + days * DAY_MS);
}

/** The last `days` day strings ending at `today`, oldest first. */
export function dayAxis(today: string, days: number): string[] {
	const axis: string[] = [];
	for (let i = days - 1; i >= 0; i--) {
		axis.push(addDays(today, -i));
	}
	return axis;
}

/**
 * Net words written per day. Each row carries a scene's word count at the end
 * of a day; the day's net for that scene is the difference against the scene's
 * previous known count (the prior in-window day, or the baseline from before
 * the window, or zero for a scene that first appears inside the window).
 */
export function dailyNetWords(
	rows: SceneDayWords[],
	baselines: Map<string, number>
): Map<string, number> {
	const byScene = new Map<string, SceneDayWords[]>();
	for (const row of rows) {
		const list = byScene.get(row.sceneId);
		if (list) list.push(row);
		else byScene.set(row.sceneId, [row]);
	}
	const net = new Map<string, number>();
	for (const [sceneId, sceneRows] of byScene) {
		sceneRows.sort((a, b) => a.day.localeCompare(b.day));
		let previous = baselines.get(sceneId) ?? 0;
		for (const row of sceneRows) {
			net.set(row.day, (net.get(row.day) ?? 0) + row.words - previous);
			previous = row.words;
		}
	}
	return net;
}

/** How many of the given days met or beat the daily word goal. Zero goal
 * means no goal, so nothing counts. */
export function daysMetGoal(daily: DailyWords[], goal: number): number {
	if (goal <= 0) return 0;
	return daily.filter((entry) => entry.words >= goal).length;
}

/** Whole calendar days from `today` until a deadline (both ISO date strings):
 * positive ahead, 0 today, negative past due. Null for no deadline. */
export function daysUntil(deadline: string | null, today: string): number | null {
	if (!deadline) return null;
	return Math.round((toUtcMs(deadline) - toUtcMs(today)) / DAY_MS);
}

/**
 * Writing streaks over a set of active days. The current streak counts back
 * from today, or from yesterday when today has no writing yet, so it does not
 * read as broken before the day's session.
 */
export function streaks(
	activeDays: Iterable<string>,
	today: string
): { current: number; longest: number } {
	const days = new Set(activeDays);
	let current = 0;
	let cursor = days.has(today) ? today : addDays(today, -1);
	while (days.has(cursor)) {
		current++;
		cursor = addDays(cursor, -1);
	}
	let longest = 0;
	const sorted = [...days].sort();
	let run = 0;
	let previous: string | null = null;
	for (const day of sorted) {
		run = previous !== null && addDays(previous, 1) === day ? run + 1 : 1;
		if (run > longest) longest = run;
		previous = day;
	}
	return { current, longest };
}
