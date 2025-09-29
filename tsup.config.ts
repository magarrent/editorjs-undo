import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    dts: true,
    format: ['cjs', 'esm'],
    minify: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    target: 'es2020',
});

