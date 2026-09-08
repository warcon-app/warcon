import { apiJson } from '$lib/server/http';

export const GET = () => apiJson({ ok: true, service: 'warcon' });
