import { ModuleScreen } from '@/components/screens/ModuleScreen';

/**
 * A module's detail page.
 *
 * The route stays dynamic, which is what a module reached straight from a URL needs: the
 * id is read from the path by the client screen, and the data it renders came from the
 * snapshot the layout already fetched.
 *
 * The `generateStaticParams` that used to live here has gone with the static demo — it
 * existed only so the export could prerender one page per module, and that build now lives
 * in `mtms-static`.
 */
export default function ModulePage() {
  return <ModuleScreen />;
}
