import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const katexVersion = process.env.npm_package_dependencies_katex?.replace(/^[~^]/, '') || '0.16.0';

export default defineConfig({
  define: { __VERSION__: JSON.stringify(katexVersion) },
  plugins: [react()],
  base: './',
  resolve: { alias: { '@': path.resolve(__dirname, './src/renderer') } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, minify: false },
});
