export interface ConfirmRequest {
	title: string;
	message: string;
	okLabel: string;
	danger: boolean;
	resolve: (ok: boolean) => void;
}

export const confirmState = $state<{ current: ConfirmRequest | null }>({ current: null });

export function confirmDialog(
	message: string,
	opts: { title?: string; okLabel?: string; danger?: boolean } = {}
): Promise<boolean> {
	return new Promise((resolve) => {
		confirmState.current?.resolve(false);
		confirmState.current = {
			title: opts.title ?? 'Confirm',
			message,
			okLabel: opts.okLabel ?? 'Confirm',
			danger: !!opts.danger,
			resolve
		};
	});
}

export function settleConfirm(ok: boolean) {
	const c = confirmState.current;
	confirmState.current = null;
	c?.resolve(ok);
}
