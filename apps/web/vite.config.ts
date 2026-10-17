import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.{ts,tsx}',
        'src/**/__tests__/**',
        'src/test/**',
        'src/**/mocks/**',
        'src/**/*.mock.{ts,tsx}',
        'src/**/*.test-helper.{ts,tsx}',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 81,
        branches: 80,
      },
    },
  },
});
