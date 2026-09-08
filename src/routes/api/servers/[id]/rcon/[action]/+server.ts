import { param, route } from '$lib/server/http';
import { runAction } from '$lib/server/rcon-run';

export const GET = route((event) => runAction(event, param(event, 'id'), param(event, 'action')));
export const POST = route((event) => runAction(event, param(event, 'id'), param(event, 'action')));
