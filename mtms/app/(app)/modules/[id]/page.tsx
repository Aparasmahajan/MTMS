import { ModuleScreen } from '@/components/screens/ModuleScreen';
import { IS_DEMO } from '@/lib/demo/config';
import { getStore } from '@/lib/server/store';

/**
 * A server wrapper around the client screen, for one reason: `generateStaticParams`
 * cannot live in a `'use client'` file, and the static demo has to prerender a page per
 * module because it has no server to render one on demand.
 *
 * In the normal build this returns nothing and the route stays dynamic, which is what a
 * module reached straight from a URL needs.
 */
export async function generateStaticParams(): Promise<{ id: string }[]> {
  if (!IS_DEMO) return [];
  const store = await getStore();
  return store.modules.map((module) => ({ id: module.id }));
}

export default function ModulePage() {
  return <ModuleScreen />;
}
