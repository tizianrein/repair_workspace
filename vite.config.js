import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Auto-generate src/public/examples/manifest.json by scanning the
 * examples directory for subfolders containing workspace.json. This means
 * dropping a new folder into examples/ is enough — no code change needed
 * for it to show up in the "Load example…" dropdown.
 *
 * Each example folder can optionally contain a meta.json with display
 * info: { name: "Display Name", description: "...", order: 10 }
 * Without meta.json the folder name is used as the display name.
 */
function examplesManifestPlugin() {
  function generate() {
    const examplesDir = path.resolve('src/public/examples');
    if (!fs.existsSync(examplesDir)) return;

    const entries = [];
    for (const entry of fs.readdirSync(examplesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const folder = path.join(examplesDir, slug);
      const wsPath = path.join(folder, 'workspace.json');
      if (!fs.existsSync(wsPath)) continue;

      let meta = {};
      const metaPath = path.join(folder, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        } catch (err) {
          console.warn(`[examples] Failed to parse ${metaPath}:`, err.message);
        }
      }

      entries.push({
        slug,
        name: meta.name || prettify(slug),
        description: meta.description || '',
        order: typeof meta.order === 'number' ? meta.order : 1000
      });
    }

    entries.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

    const outPath = path.join(examplesDir, 'manifest.json');
    fs.writeFileSync(outPath, JSON.stringify({ examples: entries }, null, 2));
    console.log(`[examples] Wrote manifest with ${entries.length} examples → ${outPath}`);
  }

  function prettify(slug) {
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  return {
    name: 'examples-manifest',
    buildStart() { generate(); },
    configureServer(server) {
      generate();
      // Watch the examples directory for additions/removals
      const examplesDir = path.resolve('src/public/examples');
      if (fs.existsSync(examplesDir)) {
        server.watcher.add(examplesDir);
        server.watcher.on('add', (file) => {
          if (file.startsWith(examplesDir)) generate();
        });
        server.watcher.on('unlink', (file) => {
          if (file.startsWith(examplesDir)) generate();
        });
        server.watcher.on('change', (file) => {
          if (file.endsWith('meta.json') && file.startsWith(examplesDir)) generate();
        });
      }
    }
  };
}

export default defineConfig({
  root: 'src',
  plugins: [examplesManifestPlugin()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2020'
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true }
    }
  }
});
