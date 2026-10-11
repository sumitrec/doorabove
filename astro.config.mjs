// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';

import { fileURLToPath } from 'node:url';

// https://docs.astro.build/config
export default defineConfig({
  output: 'server',
  adapter: vercel({
    includeFiles: ['./data/bhumi_vikas_rules.jsonl'],
  }),
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        rolldown: fileURLToPath(new URL('./src/empty.js', import.meta.url)),
      },
    },
  },
});