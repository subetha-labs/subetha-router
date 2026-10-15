import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/{contracts,catalog,model,http,demo-selection}.test.ts'], pool: 'forks', maxWorkers: 1, fileParallelism: false }, cacheDir: '../../.claude_workflow/local/api-author-checks/cache/vite' });
