import { defineConfig } from 'vite';

// Bundles the library entry (src/index.ts) into dist/index.js as an ES module.
// Type declarations are emitted separately by `tsc --emitDeclarationOnly` (see package.json build).
export default defineConfig({
	build: {
		lib: {
			entry: 'src/index.ts',
			formats: ['es'],
			fileName: () => 'index.js',
		},
		sourcemap: true,
		// Keep runtime dependencies external so they are not inlined into the bundle.  The ECS is a peer
		// dependency: a game must share the exact same copy this library's components are registered against.
		// Flatbush (the collision broadphase's R-tree) is a plain dependency, external so a game that already
		// uses it does not end up with two copies.
		rollupOptions: {
			external: [
				/^@daneren2005\/shared-memory-ecs(\/.*)?$/,
				/^@daneren2005\/shared-memory-objects(\/.*)?$/,
				/^flatbush$/,
			],
		},
	},
});
