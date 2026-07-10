/** Shared formatters and helpers — single source of truth for DTE, IV, dollar, etc. */

export function getDte(expiry: string): number {
	const diff = new Date(expiry + 'T00:00:00').getTime() - Date.now();
	return Math.max(0, Math.ceil(diff / 86400000));
}

export function formatIv(iv: number | null, decimals = 1): string {
	if (iv === null) return '\u2014';
	return (iv * 100).toFixed(decimals) + '%';
}

export function formatPts(v: number | null): string {
	if (v === null) return '\u2014';
	const pts = v * 100;
	return (pts >= 0 ? '+' : '') + pts.toFixed(1);
}

export function formatDeviation(dev: number | null): string {
	if (dev === null) return '\u2014';
	return (dev > 0 ? '+' : '') + (dev * 100).toFixed(2);
}

export function formatDollar(val: number | null): string {
	if (val === null) return '\u2014';
	return '$' + val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatGreek(val: number | null, decimals = 4): string {
	if (val === null) return '\u2014';
	return val.toFixed(decimals);
}

export function timeAgo(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	return `${days}d ago`;
}
