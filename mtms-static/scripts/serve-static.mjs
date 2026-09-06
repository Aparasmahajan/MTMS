import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serves the built static site.
 *
 * Node's own http module rather than `npx serve`, for one practical reason: `npx` wants to
 * fetch the package, and the machine this was built on cannot reach the registry. A static
 * file server is forty lines, and this way `npm run serve` works with nothing installed.
 *
 * It is a viewing tool, not a deployment. The output in `demo/` is plain files — any static
 * host, an S3 bucket, a network share, or a USB stick will serve them equally well.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo');
const port = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Maps a URL to a file the way a static host does: exact file, then `index.html` inside a
 * directory, then the same path with `.html` appended — which is the shape `next build`
 * produces for a route like `/matrix`.
 */
function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);

  // Contain it. A request for `/../../etc/passwd` must not escape the output directory.
  const candidate = path.normalize(path.join(root, decoded));
  if (!candidate.startsWith(root)) return null;

  for (const attempt of [candidate, path.join(candidate, 'index.html'), `${candidate}.html`]) {
    if (existsSync(attempt) && statSync(attempt).isFile()) return attempt;
  }
  return null;
}

createServer((request, response) => {
  const file = resolveFile(request.url ?? '/') ?? path.join(root, '404.html');
  const found = file.endsWith('404.html') && !existsSync(file) ? null : file;

  if (!found) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found');
    return;
  }

  response.writeHead(found.endsWith('404.html') ? 404 : 200, {
    'content-type': TYPES[path.extname(found)] ?? 'application/octet-stream',
    // No caching: this exists to look at a build you just made.
    'cache-control': 'no-store',
  });
  createReadStream(found).pipe(response);
}).listen(port, () => {
  console.log(`[static] serving ${path.relative(process.cwd(), root)}/ on http://localhost:${port}`);
  console.log('[static] open it in two tabs to see edits sync between them');
});
