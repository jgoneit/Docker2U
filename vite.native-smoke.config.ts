import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// A separate entry/output prevents any fixture, worker wrapper or probe entering dist/.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/test/native-smoke'),
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: resolve(import.meta.dirname, '.cache/native-smoke/dist'),
    emptyOutDir: true,
  },
});
