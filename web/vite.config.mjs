import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {uiLicenses} from '../scripts/ui-licenses.mjs';

// 小さな文字のファイルも data: に埋め込まずに別のファイルとして出す（ページの決まりで、文字は同じ場所からだけ読む）。
export default defineConfig({ root: 'web', plugins: [react(),uiLicenses()], build: { outDir: '../dist/client', emptyOutDir: true, assetsInlineLimit: 0 } });
