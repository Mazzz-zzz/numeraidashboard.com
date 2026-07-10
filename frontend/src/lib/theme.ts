/** Color constants for Plotly charts and JS usage. CSS uses var(--*) equivalents. */
export const colors = {
	bg: '#ffffff',
	bgPage: '#f6f8fa',
	border: '#d1d9e0',
	borderLight: '#e1e4e8',
	text: '#1f2328',
	textSecondary: '#656d76',
	textMuted: '#8b949e',
	blue: '#0969da',
	green: '#1a7f37',
	red: '#cf222e',
	orange: '#bc4c00',
	purple: '#8250df',
	yellow: '#9a6700',
};

/** Reusable Plotly chart colors for multi-series plots. */
export const chartColors = [
	'#0969da', '#1a7f37', '#bc4c00', '#cf222e', '#8250df',
	'#9a6700', '#0550ae', '#116329', '#953800', '#a40e26',
	'#6639ba', '#7d4e00',
];

/** Base Plotly layout for consistent chart styling. */
export function plotlyLayout(overrides: Record<string, any> = {}): Record<string, any> {
	return {
		paper_bgcolor: colors.bg,
		plot_bgcolor: colors.bg,
		font: { color: colors.textSecondary },
		margin: { t: 50, b: 50, l: 60, r: 20 },
		hovermode: 'closest',
		...overrides,
	};
}

/** Standard axis config. */
export function plotlyAxis(title?: string, extras: Record<string, any> = {}): Record<string, any> {
	return {
		title,
		color: colors.textSecondary,
		gridcolor: colors.borderLight,
		...extras,
	};
}

/** Standard legend config. */
export const plotlyLegend = {
	bgcolor: 'rgba(255,255,255,0.9)',
	font: { color: colors.text, size: 10 },
};
