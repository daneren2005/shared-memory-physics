import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The examples are a separate Vite app from the library build (../vite.config.ts), so the config lives here
// and is pointed at from the root package.json:
//
//   npm start          - serves this directory with hot reload
//   npm run build:examples - builds it into examples/dist for GitHub Pages
const root = fileURLToPath(new URL('.', import.meta.url));

// Written as a game would write it - `import { PhysicsSystem } from '@daneren2005/shared-memory-physics'` -
// rather than reaching up into ../src, so the example code is copy-pasteable into a real project.  The alias
// points that name at the library source next door, so editing a system reloads the running example rather
// than needing a publish and an install first.
const library = fileURLToPath(new URL('../src/index.ts', import.meta.url));

// GitHub Pages serves the site under the repository name (and dev builds under a subdirectory of that), so
// the base is handed in by the workflow.  Locally it is the root of the dev server.
const base = process.env.EXAMPLES_BASE ?? '/';

// SharedArrayBuffer - the whole point of this library - is only handed out to a cross-origin isolated page,
// which takes these two headers.  Without them the ECS falls back to a plain ArrayBuffer and physics runs on
// the main thread, which still works but is not what the examples are here to show.
//
// 127.0.0.1 is a secure context as far as the browser is concerned, the same way localhost is, so serving from
// it is enough for the headers to be honoured - no certificate needed.
const server = {
	host: '127.0.0.1',
	port: 8080,
	headers: {
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Cross-Origin-Embedder-Policy': 'require-corp',
	},
};

export default defineConfig({
	root,
	base,
	resolve: {
		alias: {
			'@daneren2005/shared-memory-physics': library,
		},
	},
	server,
	// The same everything for `npm run preview:examples`, which serves the built output rather than the source -
	// so a check against the real bundle is a check against the real headers too.
	preview: server,
});
