// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';

// https://docs.astro.build/config
export default defineConfig({
  output: 'server',
  adapter: vercel({
    includeFiles: ['./data/bhumi_vikas_rules.jsonl'],
  }),
  vite: {
    plugins: [tailwindcss()],
  },
});