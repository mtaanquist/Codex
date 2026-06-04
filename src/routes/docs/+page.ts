import type { PageLoad } from './$types';
import { docTopics } from '$lib/docs';

export const load: PageLoad = () => ({ topics: docTopics() });
