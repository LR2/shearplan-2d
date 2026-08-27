import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// base './' makes the build work at any URL, including
// https://USERNAME.github.io/REPO-NAME/ — no config needed per repo.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
});
