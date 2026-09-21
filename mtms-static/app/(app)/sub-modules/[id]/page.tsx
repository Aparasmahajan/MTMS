import { SubModuleScreen } from '@/components/screens/SubModuleScreen';
import { IS_DEMO } from '@/lib/demo/config';
import { getStore } from '@/lib/server/store';

/**
 * A sub-module's detail page — the matrix row opened up, with its checklists, owners and
 * discussion.
 *
 * A server wrapper around the client screen for one reason: `generateStaticParams` cannot
 * live in a `'use client'` file, and the static demo has to prerender a page per sub-module
 * because it has no server to render one on demand.
 *
 * In the normal build this returns nothing and the route stays dynamic, which is what a
 * sub-module reached straight from a URL needs.
 */
export async function generateStaticParams(): Promise<{ id: string }[]> {
  if (!IS_DEMO) return [];
  const store = await getStore();
  return store.sub_modules.map((subModule) => ({ id: subModule.id }));
}

export default function SubModulePage() {
  return <SubModuleScreen />;
}
