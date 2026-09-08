import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	casing: 'snake_case',
	dbCredentials: {
		url: process.env.DATABASE_URL ?? 'postgres://warcon:warcon@127.0.0.1:5432/warcon'
	}
});
