import { ModuleDetailScreen } from '@/components/screens/ModuleDetailScreen';
import { IS_DEMO } from '@/lib/demo/config';
import { getStore } from '@/lib/server/store';

/**
 * One module — what the matrix already knows about it, plus the things that can only attach
 * to a record rather than to a name: its owners and its discussion.
 *
 * This route used to be the *sub-module* detail page, back when the code called a matrix row
 * a "module". It moved to `/sub-modules/[id]` with the rename, and this is the screen the
 * name now means.
 *
 * A server wrapper for the same reason as its neighbour: `generateStaticParams` cannot live
 * in a `'use client'` file, and the export has to prerender one page per module.
 */
export async function generateStaticParams(): Promise<{ id: string }[]> {
  if (!IS_DEMO) return [];
  const store = await getStore();
  return store.modules.map((module) => ({ id: module.id }));
}

export default function ModulePage() {
  return <ModuleDetailScreen />;
}
