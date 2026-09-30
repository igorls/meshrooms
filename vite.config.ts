import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { realpathSync } from 'node:fs';
import { mockRoomPlugin } from './server/mockRoom.ts';

export default defineConfig({
  plugins: [mockRoomPlugin()],
  server: {
    host: '127.0.0.1', port: 4317, strictPort: true,
    proxy: { '/api/node': { target: 'http://127.0.0.1:4318', changeOrigin: false } },
    // Bun may link this package outside the checkout. Allow only its font assets.
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), realpathSync('node_modules/@fontsource-variable/manrope')] },
  },
});
