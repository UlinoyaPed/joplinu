import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/browser',
	use: {
		baseURL: 'http://127.0.0.1:5173',
		launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/usr/bin/chromium', args: ['--no-sandbox'] },
		trace: 'retain-on-failure',
	},
	webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI },
});
