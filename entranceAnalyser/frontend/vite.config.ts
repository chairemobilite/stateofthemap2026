import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        // Forward `/api` to the Rust backend. Keeps the frontend
        // origin-relative and sidesteps CORS during development.
        proxy: {
            '/api': 'http://127.0.0.1:3000',
        },
    },
    test: {
        environment: 'jsdom',
        setupFiles: ['./src/test/setup.ts'],
        css: false,
    },
});
