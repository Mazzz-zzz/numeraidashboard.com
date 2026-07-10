import { describe, expect, it } from 'vitest';
import { loadGoogleAnalytics, normalizeGoogleAnalyticsMeasurementId } from './analytics';

describe('analytics configuration', () => {
	it('accepts configured Google Analytics measurement ids', () => {
		expect(normalizeGoogleAnalyticsMeasurementId(' G-ABC123XYZ ')).toBe('G-ABC123XYZ');
	});

	it('rejects missing and malformed measurement ids', () => {
		expect(normalizeGoogleAnalyticsMeasurementId(undefined)).toBeNull();
		expect(normalizeGoogleAnalyticsMeasurementId('')).toBeNull();
		expect(normalizeGoogleAnalyticsMeasurementId('UA-12345')).toBeNull();
		expect(normalizeGoogleAnalyticsMeasurementId('G-ID?callback=attack')).toBeNull();
	});

	it('does not load analytics during server rendering', () => {
		expect(loadGoogleAnalytics('G-ABC123XYZ')).toBe(false);
	});
});
