import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    outDir: 'dist-electron',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        main: path.resolve(__dirname, 'src/main/main.ts'),
        preload: path.resolve(__dirname, 'src/main/preload.ts'),
      },
      formats: ['cjs'],
    },
    rollupOptions: {
      external: [
        'electron',
        'sql.js',
        'discord.js',
        'zlib-sync',
        '@discordjs/opus',
        'bufferutil',
        'utf-8-validate',
        'node-nim',
        'nim-web-sdk-ng',
        /^node:/,
        // Mark all node_modules as external for electron main
        /^[a-z@]/,
      ],
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
});
