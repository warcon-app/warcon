import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { getServer } from '$lib/server/access';
import { account, user } from '$lib/server/db/schema';
import { serverListsState } from '$lib/server/lists';
import { newId } from '$lib/server/http';
import { hasTestDb, testEnv } from './db';
import { stubGateway } from './call';
import { seedWorld } from './world';

describe.skipIf(!hasTestDb)('online player role labels', () => {
 let env: Env;
 beforeAll(async () => { env = await testEnv(); stubGateway(); });
 test('owners and grants are scoped to the server, and a Steam login wins over a manual ID', async () => {
  const w = await seedWorld(env);
  const ownerId = '76561198000000601';
  const adminManualId = '76561198000000602';
  const adminLinkedId = '76561198000000603';
  const elsewhereId = '76561198000000604';
  await env.db.update(user).set({ steamId: ownerId }).where(eq(user.id, w.users.owner!.id));
  await env.db.update(user).set({ steamId: adminManualId }).where(eq(user.id, w.users.admin!.id));
  await env.db.update(user).set({ steamId: elsewhereId }).where(eq(user.id, w.users.elsewhere!.id));
  await env.db.insert(account).values({ id: newId(), userId: w.users.admin!.id, providerId: 'steam', accountId: adminLinkedId });
  const server = (await getServer(env, w.server.id))!;
  const result = await serverListsState(env, server, w.users.owner!, { caps: new Set(['server.view']) } as never);
  expect(result.roles?.[ownerId]).toBe('owner');
  expect(result.roles?.[adminLinkedId]).toBe('admin');
  expect(result.roles?.[adminManualId]).toBeUndefined();
  expect(result.roles?.[elsewhereId]).toBeUndefined();
  await env.db.update(user).set({ banned: true }).where(eq(user.id, w.users.admin!.id));
  const afterBan = await serverListsState(env, server, w.users.owner!, { caps: new Set(['server.view']) } as never);
  expect(afterBan.roles?.[adminLinkedId]).toBeUndefined();
 });
});
