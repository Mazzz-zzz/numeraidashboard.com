type AnalyticsWindow = Window & {
	dataLayer?: unknown[][];
	gtag?: (...args: unknown[]) => void;
};

const GOOGLE_ANALYTICS_SCRIPT_ID = 'google-analytics-script';

export function normalizeGoogleAnalyticsMeasurementId(value: string | null | undefined): string | null {
	const measurementId = value?.trim();
	return measurementId && /^G-[A-Z0-9]{4,20}$/i.test(measurementId) ? measurementId : null;
}

export function loadGoogleAnalytics(value: string | null | undefined): boolean {
	const measurementId = normalizeGoogleAnalyticsMeasurementId(value);
	if (!measurementId || typeof window === 'undefined' || typeof document === 'undefined') return false;

	const analyticsWindow = window as AnalyticsWindow;
	const dataLayer = (analyticsWindow.dataLayer ??= []);
	analyticsWindow.gtag = (...args: unknown[]) => dataLayer.push(args);
	analyticsWindow.gtag('js', new Date());
	analyticsWindow.gtag('config', measurementId);

	if (!document.getElementById(GOOGLE_ANALYTICS_SCRIPT_ID)) {
		const script = document.createElement('script');
		script.id = GOOGLE_ANALYTICS_SCRIPT_ID;
		script.async = true;
		script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
		document.head.append(script);
	}

	return true;
}
