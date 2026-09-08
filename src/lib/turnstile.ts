// Cloudflare Turnstile widget as a Svelte action: `<div use:turnstile={siteKey}>`. Loads the
// script once, renders explicitly (so a form that appears after page load still gets a widget),
// and removes the widget when the element goes away. The token lands in the enclosing form as
// the hidden field `cf-turnstile-response`, which the server verifies.
import type { Action } from 'svelte/action';

interface TurnstileApi {
	render: (el: HTMLElement, opts: Record<string, unknown>) => string;
	remove: (id: string) => void;
	reset: (id?: string) => void;
}
declare global {
	interface Window {
		turnstile?: TurnstileApi;
		__warconTurnstileReady?: () => void;
	}
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
let loading: Promise<TurnstileApi> | null = null;

function load(): Promise<TurnstileApi> {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	if (!loading) {
		loading = new Promise((resolve, reject) => {
			window.__warconTurnstileReady = () => resolve(window.turnstile!);
			const s = document.createElement('script');
			s.src = `${SCRIPT}?onload=__warconTurnstileReady&render=explicit`;
			s.async = true;
			s.defer = true;
			s.onerror = () => reject(new Error('Turnstile script failed to load.'));
			document.head.appendChild(s);
		});
	}
	return loading;
}

let widgetId: string | null = null;

export const turnstile: Action<HTMLElement, string> = (el, siteKey) => {
	let alive = true;
	void load()
		.then((api) => {
			if (!alive) return;
			widgetId = api.render(el, { sitekey: siteKey, theme: 'dark', size: 'flexible' });
		})
		.catch((err) => console.warn(err));
	return {
		destroy() {
			alive = false;
			if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
			widgetId = null;
		}
	};
};

/** Tokens are single-use: call after a rejected submit so the next attempt gets a fresh one. */
export function resetTurnstile(): void {
	if (widgetId && window.turnstile) window.turnstile.reset(widgetId);
}
