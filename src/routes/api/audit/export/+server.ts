// Export up to 10k rows matching the filters as CSV or JSON.
import { getEnv } from '$lib/server/env';
import { route } from '$lib/server/http';
import { adminServerIds, requireUser } from '$lib/server/access';
import { auditFilters, queryAudit, type AuditRow } from '$lib/server/audit';

function csvEscape(v: unknown): string {
	const s =
		v === null || v === undefined
			? ''
			: v instanceof Date
				? v.toISOString()
				: typeof v === 'object'
					? JSON.stringify(v)
					: String(v);
	return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const GET = route(async ({ locals, url }) => {
	const env = getEnv();
	const user = requireUser(locals);
	const visibleTo =
		user.role === 'owner'
			? null
			: { userId: user.id, adminServerIds: await adminServerIds(env, user) };
	const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
	const filters = { ...auditFilters(url.searchParams), visibleTo, limit: 500 };
	const rows: AuditRow[] = [];
	let before: number | undefined = filters.before;
	while (rows.length < 10000) {
		const page = await queryAudit(env, { ...filters, before });
		rows.push(...page.entries);
		if (!page.nextBefore) break;
		before = page.nextBefore;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	if (format === 'json') {
		return new Response(JSON.stringify(rows, null, 2), {
			headers: {
				'content-type': 'application/json',
				'content-disposition': `attachment; filename="warcon-audit-${stamp}.json"`
			}
		});
	}
	const cols: (keyof AuditRow)[] = [
		'id',
		'ts',
		'actorName',
		'actorId',
		'serverName',
		'serverId',
		'category',
		'action',
		'target',
		'outcome',
		'status',
		'message',
		'detail',
		'ip',
		'userAgent',
		'durationMs'
	];
	const lines = [cols.join(',')];
	for (const row of rows) lines.push(cols.map((k) => csvEscape(row[k])).join(','));
	return new Response(lines.join('\r\n'), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="warcon-audit-${stamp}.csv"`
		}
	});
});
