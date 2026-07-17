<script lang="ts">
	import { onMount } from 'svelte';
	import { docsSpec } from '$lib/docs/docs-spec';

	let host: HTMLDivElement;

	onMount(() => {
		let disposed = false;
		let destroy: (() => void) | undefined;

		void import('@scalar/api-reference').then(({ createApiReference }) => {
			if (disposed) return;
			const reference = createApiReference(host, {
				content: docsSpec,
				theme: 'default',
				layout: 'modern',
				hideClientButton: true,
				hideTestRequestButton: true,
				hideModels: false,
				modelsSectionLabel: 'MCP tools and model configs',
				documentDownloadType: 'json',
				metaData: {
					title: 'Docs | Numerai Dashboard',
					description: 'MCP tools, training workflows, and model configuration reference.'
				},
				customCss: `
					.scalar-app { min-height: calc(100vh - var(--nav-height)); }
					.references-layout { min-height: calc(100vh - var(--nav-height)); }
					.section-flare { display: none; }
				`
			});
			destroy = reference.destroy;
		});

		return () => {
			disposed = true;
			destroy?.();
		};
	});
</script>

<svelte:head>
	<title>Docs | Numerai Dashboard</title>
	<meta
		name="description"
		content="Numerai Dashboard MCP tools, local training workflows, and model configuration reference."
	/>
</svelte:head>

<div class="docs-reference" bind:this={host}>
	<p class="loading">Loading documentation…</p>
</div>

<noscript>
	<p class="noscript">JavaScript is required to render the Scalar documentation.</p>
</noscript>

<style>
	.docs-reference {
		min-height: calc(100vh - var(--nav-height));
		background: #fff;
	}

	.loading,
	.noscript {
		margin: 0;
		padding: 2rem;
		color: var(--text-secondary);
	}
</style>
