// Tables as they were at an older migration, for the tests that build a database at one and fill it
// before the rest are applied: an insert through the current table names every column it has now,
// and a column a later migration adds is not there yet.
import { bigint, bigserial, integer, pgTable, real, text, timestamp } from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** player_sessions before migration 0053 gave it `hidden_name`. */
export const playerSessionsBefore53 = pgTable('player_sessions', {
	id: bigserial('id', { mode: 'number' }).primaryKey(),
	serverId: text('server_id').notNull(),
	steamId: text('steam_id').notNull(),
	name: text('name').notNull(),
	faction: text('faction'),
	joinedAt: ts('joined_at').notNull(),
	lastSeen: ts('last_seen').notNull(),
	leftAt: ts('left_at'),
	kills: integer('kills').notNull().default(0),
	deaths: integer('deaths').notNull().default(0),
	cash: integer('cash').notNull().default(0),
	seedSeconds: integer('seed_seconds').notNull().default(0)
});

/** match_players before migration 0053 gave it `hidden_name`. */
export const matchPlayersBefore53 = pgTable('match_players', {
	matchId: bigint('match_id', { mode: 'number' }).notNull(),
	serverId: text('server_id').notNull(),
	steamId: text('steam_id').notNull(),
	name: text('name').notNull(),
	faction: text('faction'),
	seconds: integer('seconds').notNull().default(0),
	kills: integer('kills').notNull().default(0),
	deaths: integer('deaths').notNull().default(0),
	cashDelta: integer('cash_delta').notNull().default(0),
	headshots: integer('headshots').notNull().default(0),
	teamKills: integer('team_kills').notNull().default(0),
	suicides: integer('suicides').notNull().default(0),
	vehicleKills: integer('vehicle_kills').notNull().default(0),
	longestM: real('longest_m'),
	killStreak: integer('kill_streak').notNull().default(0),
	deathStreak: integer('death_streak').notNull().default(0)
});
