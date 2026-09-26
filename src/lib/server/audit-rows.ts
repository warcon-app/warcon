/**
 * Adding, editing and deleting a server is its org's owners at work, and those rows say where
 * RCON listens and carry the owners' notes: Audit trail on the server does not show them, and a
 * Discord channel gets the action and the server's name only.
 */
export const OWNERS_ROWS = ['server.create', 'server.update', 'server.delete'];

/**
 * Changes to an org's ban or reserve list entries. An org list is enforced on every server of the
 * org, so an API key that reads the audit trail of every one of them sees these too (see
 * access.ts auditVisibility). Who may edit the lists (`list.members`) is the owners' business and
 * stays out.
 */
export const ORG_LIST_ROWS = [
	'list.add',
	'list.remove',
	'list.update',
	'list.import',
	'list.expire'
];
