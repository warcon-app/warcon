import { untrack } from 'svelte';

export type ToastKind = '' | 'ok' | 'err';
export interface Toast {
	id: number;
	message: string;
	kind: ToastKind;
}

export const toasts = $state<Toast[]>([]);
let seq = 0;

export function dismiss(id: number) {
	const i = toasts.findIndex((t) => t.id === id);
	if (i >= 0) toasts.splice(i, 1);
}

/** Shows a toast; returns a function that removes it early. */
export function toast(message: string, kind: ToastKind = '', ttlMs?: number): () => void {
	const id = ++seq;
	// Called from $effect blocks that react to form results; push reads the array's length, which
	// would make such an effect depend on the toasts it creates and loop.
	untrack(() => toasts.push({ id, message, kind }));
	const ms = ttlMs ?? (kind === 'err' ? 7000 : 4000);
	if (ms > 0) setTimeout(() => dismiss(id), ms);
	return () => dismiss(id);
}
