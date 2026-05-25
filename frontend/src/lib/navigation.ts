export type NavItem = {
	readonly href: string;
	readonly label: string;
};

export const dashboardNavItem: NavItem = {
	href: '/',
	label: 'Dashboard'
};

export const docsNavItem: NavItem = {
	href: '/docs',
	label: 'Docs'
};

export const authenticatedNavItems: readonly NavItem[] = [
	{ href: '/builder', label: 'Builder' },
	{ href: '/models', label: 'Models' },
	{ href: '/launch', label: 'Launch' },
	docsNavItem,
	{ href: '/settings', label: 'Settings' }
] as const;

export const fullbleedRoutePrefixes = ['/settings'] as const;

export function primaryNavItems(isAuthenticated: boolean): readonly NavItem[] {
	return isAuthenticated ? [dashboardNavItem, ...authenticatedNavItems] : [dashboardNavItem, docsNavItem];
}

export function isNavItemActive(pathname: string, href: string): boolean {
	if (href === '/') return pathname === '/';
	return pathname === href || pathname.startsWith(`${href}/`);
}

export function isFullbleedRoute(pathname: string): boolean {
	return fullbleedRoutePrefixes.some((prefix) => pathname.startsWith(prefix));
}
