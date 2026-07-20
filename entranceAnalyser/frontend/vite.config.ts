/*
 * Copyright Polytechnique Montreal and contributors
 *
 * This file is licensed under the MIT License.
 * License text available at https://opensource.org/licenses/MIT
 */

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/** Proxy OSM raster tiles through the dev server so MapLibre loads them same-origin. */
const osmTileProxy = {
    target: 'https://tile.openstreetmap.org',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/tiles\/osm/, ''),
    headers: {
        // OSM tile policy requires an identifying User-Agent; browser fetches
        // are often blocked and surface as CORS errors when the 403 omits ACAO.
        'User-Agent': 'EntranceAnalyser/0.1 (local dev; OSM Science 2026)',
    },
};

// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        // Forward `/api` to the Rust backend and `/tiles/osm` to tile.openstreetmap.org.
        // Keeps the frontend origin-relative and sidesteps CORS during development.
        proxy: {
            '/api': 'http://127.0.0.1:3000',
            '/tiles/osm': osmTileProxy,
        },
    },
    preview: {
        proxy: {
            '/api': 'http://127.0.0.1:3000',
            '/tiles/osm': osmTileProxy,
        },
    },
    test: {
        environment: 'jsdom',
        setupFiles: ['./src/test/setup.ts'],
        css: false,
    },
});
