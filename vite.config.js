import { defineConfig } from 'vite';

// GitHub Pages 專案頁面路徑：https://<user>.github.io/<repo>/
// 部署時 base 必須對應 repo 名，否則資源會 404。
export default defineConfig({
  base: '/indirect-lighting-calculator/',
  server: {
    port: 3000,
    host: true,
  },
});
