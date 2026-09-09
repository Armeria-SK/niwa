import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {uiLicenses} from '../scripts/ui-licenses.mjs';

export default defineConfig({ root: 'web', plugins: [react(),uiLicenses()], build: { outDir: '../dist/client', emptyOutDir: true } });
