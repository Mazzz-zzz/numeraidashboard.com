import { describe, expect, it } from 'vitest';
import {
	authenticatedNavItems,
	isFullbleedRoute,
	isNavItemActive,
	primaryNavItems
} from './navigation';

describe('navigation', () => {
	it('shows only Dashboard before authentication', () => {
		expect(primaryNavItems(false)).toEqual([
			{ href: '/', label: 'Dashboard' },
			{ href: '/docs', label: 'Docs' }
		]);
	});

	it('uses the target authenticated top-level tabs', () => {
		expect(primaryNavItems(true).map((item) => item.label)).toEqual([
			'Dashboard',
			'Builder',
			'Models',
			'Launch',
			'Submissions',
			'Docs',
			'Settings'
		]);
	});

	it('keeps retired flow routes out of the top-level authenticated nav', () => {
		const hrefs = authenticatedNavItems.map((item) => item.href);

		expect(hrefs).not.toContain('/evolution');
		expect(hrefs).not.toContain('/predict');
		expect(hrefs).not.toContain('/compute');
	});

	it('matches exact and nested route activity without making Dashboard active everywhere', () => {
		expect(isNavItemActive('/', '/')).toBe(true);
		expect(isNavItemActive('/models', '/models')).toBe(true);
		expect(isNavItemActive('/models/lineage', '/models')).toBe(true);
		expect(isNavItemActive('/builder', '/')).toBe(false);
		expect(isNavItemActive('/models', '/compute')).toBe(false);
	});

	it('keeps current full-bleed routes isolated from Models lineage', () => {
		expect(isFullbleedRoute('/settings')).toBe(true);
		expect(isFullbleedRoute('/settings/providers')).toBe(true);
		expect(isFullbleedRoute('/models')).toBe(false);
		expect(isFullbleedRoute('/models/lineage')).toBe(false);
		expect(isFullbleedRoute('/models/submit')).toBe(false);
	});
});
