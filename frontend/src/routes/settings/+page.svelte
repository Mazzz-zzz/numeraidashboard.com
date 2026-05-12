<script lang="ts">
	import { onMount } from 'svelte';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import { authState, getPasskeys, registerPasskey, deletePasskey } from '$lib/auth';
	import { dataClient } from '$lib/data';
	import { addToast } from '$lib/stores';
	import type { Schema } from '../../../amplify/data/resource';

	import { SvelteFlow, Background, Controls, type Node, type Edge } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';

	import SourceNode from '$lib/components/flow-nodes/SourceNode.svelte';
	import HubNode from '$lib/components/flow-nodes/HubNode.svelte';
	import ProviderNode from '$lib/components/flow-nodes/ProviderNode.svelte';
	import AddNode from '$lib/components/flow-nodes/AddNode.svelte';
	import PasskeyNode from '$lib/components/flow-nodes/PasskeyNode.svelte';

	type NumeraiAccount = Schema['NumeraiAccount']['type'];
	type ComputeProvider = Schema['ComputeProvider']['type'];
	type ProviderType = 'prime_intellect' | 'modal' | 'sagemaker' | 'local' | 'custom';

	type Passkey = {
		credentialId: string;
		friendlyCredentialName?: string;
		createdAt?: string;
	};

	const providerTypes: ProviderType[] = ['prime_intellect', 'modal', 'sagemaker', 'local', 'custom'];
	const providerLabels: Record<ProviderType, string> = {
		prime_intellect: 'Prime Intellect',
		modal: 'Modal',
		sagemaker: 'AWS SageMaker',
		local: 'Local',
		custom: 'Custom'
	};

	let numeraiAccount = $state<NumeraiAccount | null>(null);
	let providers = $state<ComputeProvider[]>([]);
	let passkeys = $state<Passkey[]>([]);
	let loading = $state(true);

	type DrawerState =
		| { kind: 'none' }
		| { kind: 'numerai' }
		| { kind: 'passkeys' }
		| { kind: 'provider'; id: string }
		| { kind: 'add-provider' };
	let drawer = $state<DrawerState>({ kind: 'none' });

	let numeraiForm = $state({ label: '', publicId: '', secretKey: '' });
	let providerForm = $state({
		name: '',
		providerType: 'prime_intellect' as ProviderType,
		credentialsJson: '',
		monthlyBudgetUsd: '',
		notes: ''
	});
	let busy = $state(false);

	onMount(() => {
		if ($authState.user) void loadAll();
	});

	$effect(() => {
		if ($authState.user && loading) void loadAll();
	});

	async function loadAll() {
		loading = true;
		await Promise.all([loadNumerai(), loadProviders(), loadPasskeys()]);
		loading = false;
	}

	async function loadNumerai() {
		try {
			const { data } = await dataClient().models.NumeraiAccount.list();
			numeraiAccount = (data?.[0] ?? null) as NumeraiAccount | null;
		} catch (e) {
			addToast(asMessage(e, 'Failed to load Numerai account'), 'error');
		}
	}

	async function loadProviders() {
		try {
			const { data } = await dataClient().models.ComputeProvider.list();
			providers = (data ?? []) as ComputeProvider[];
		} catch (e) {
			addToast(asMessage(e, 'Failed to load providers'), 'error');
		}
	}

	async function loadPasskeys() {
		try {
			const result = await getPasskeys();
			passkeys = (result?.credentials ?? []) as Passkey[];
		} catch (e) {
			addToast(asMessage(e, 'Failed to load passkeys'), 'error');
		}
	}

	const nodeTypes = {
		source: SourceNode,
		hub: HubNode,
		provider: ProviderNode,
		add: AddNode,
		passkey: PasskeyNode
	};

	const nodes = $derived<Node[]>(buildNodes());
	const edges = $derived<Edge[]>(buildEdges());

	function buildNodes(): Node[] {
		const out: Node[] = [
			{
				id: 'numerai',
				type: 'source',
				position: { x: 0, y: 80 },
				data: {
					label: numeraiAccount?.label || 'Numerai account',
					sub: numeraiAccount ? `id ${numeraiAccount.publicId.slice(0, 8)}…` : 'Click to link',
					linked: !!numeraiAccount
				}
			},
			{
				id: 'hub',
				type: 'hub',
				position: { x: 360, y: 60 },
				data: {
					label: 'Numerai Dashboard',
					sub: $authState.email ?? 'Workspace'
				}
			},
			{
				id: 'passkeys',
				type: 'passkey',
				position: { x: 360, y: 240 },
				data: { count: passkeys.length }
			}
		];

		const providerYStart = -40;
		const providerYStep = 100;
		providers.forEach((p, i) => {
			out.push({
				id: `provider-${p.id}`,
				type: 'provider',
				position: { x: 720, y: providerYStart + i * providerYStep },
				data: {
					label: p.name,
					providerType: p.providerType as ProviderType,
					sub: p.monthlyBudgetUsd != null ? `$${p.monthlyBudgetUsd}/mo cap` : 'no budget cap'
				}
			});
		});
		out.push({
			id: 'add-provider',
			type: 'add',
			position: { x: 720, y: providerYStart + providers.length * providerYStep },
			data: { label: 'Add compute provider' }
		});

		return out;
	}

	function buildEdges(): Edge[] {
		const out: Edge[] = [
			{
				id: 'e-numerai-hub',
				source: 'numerai',
				target: 'hub',
				type: 'smoothstep',
				animated: !!numeraiAccount,
				style: 'stroke: var(--text); stroke-width: 1.4;'
			},
			{
				id: 'e-hub-passkeys',
				source: 'hub',
				sourceHandle: 'bottom',
				target: 'passkeys',
				targetHandle: 'top',
				type: 'smoothstep',
				style: 'stroke: var(--text); stroke-width: 1.4;'
			}
		];
		providers.forEach((p) => {
			out.push({
				id: `e-hub-${p.id}`,
				source: 'hub',
				target: `provider-${p.id}`,
				type: 'smoothstep',
				animated: true,
				style: 'stroke: var(--text); stroke-width: 1.4;'
			});
		});
		out.push({
			id: 'e-hub-add',
			source: 'hub',
			target: 'add-provider',
			type: 'smoothstep',
			style: 'stroke: var(--text); stroke-width: 1.2; stroke-dasharray: 4 4;'
		});
		return out;
	}

	function handleNodeClick({ node }: { node: Node; event: MouseEvent | TouchEvent }) {
		if (node.id === 'hub') return;
		if (node.id === 'numerai') {
			numeraiForm = {
				label: numeraiAccount?.label ?? '',
				publicId: numeraiAccount?.publicId ?? '',
				secretKey: ''
			};
			drawer = { kind: 'numerai' };
		} else if (node.id === 'passkeys') {
			drawer = { kind: 'passkeys' };
		} else if (node.id === 'add-provider') {
			providerForm = {
				name: '',
				providerType: 'prime_intellect',
				credentialsJson: '',
				monthlyBudgetUsd: '',
				notes: ''
			};
			drawer = { kind: 'add-provider' };
		} else if (node.type === 'provider') {
			const id = node.id.replace(/^provider-/, '');
			const p = providers.find((pp) => pp.id === id);
			if (p) {
				providerForm = {
					name: p.name,
					providerType: (p.providerType as ProviderType) ?? 'custom',
					credentialsJson: p.credentialsJson ? JSON.stringify(p.credentialsJson, null, 2) : '',
					monthlyBudgetUsd: p.monthlyBudgetUsd != null ? String(p.monthlyBudgetUsd) : '',
					notes: p.notes ?? ''
				};
				drawer = { kind: 'provider', id };
			}
		}
	}

	function closeDrawer() {
		drawer = { kind: 'none' };
	}

	async function saveNumerai(event: Event) {
		event.preventDefault();
		if (!numeraiForm.publicId.trim() || (!numeraiForm.secretKey.trim() && !numeraiAccount)) {
			addToast('Public ID and secret key are required', 'error');
			return;
		}
		busy = true;
		try {
			const payload = {
				publicId: numeraiForm.publicId.trim(),
				label: numeraiForm.label.trim() || undefined,
				...(numeraiForm.secretKey.trim() ? { secretKey: numeraiForm.secretKey.trim() } : {})
			};
			if (numeraiAccount?.id) {
				const { data } = await dataClient().models.NumeraiAccount.update({ id: numeraiAccount.id, ...payload });
				numeraiAccount = data as NumeraiAccount;
			} else {
				if (!numeraiForm.secretKey.trim()) {
					addToast('Secret key is required when linking for the first time', 'error');
					return;
				}
				const { data } = await dataClient().models.NumeraiAccount.create({
					publicId: payload.publicId,
					secretKey: numeraiForm.secretKey.trim(),
					label: payload.label
				});
				numeraiAccount = data as NumeraiAccount;
			}
			addToast('Numerai account saved', 'success');
			closeDrawer();
		} catch (e) {
			addToast(asMessage(e, 'Failed to save Numerai account'), 'error');
		} finally {
			busy = false;
		}
	}

	async function removeNumerai() {
		if (!numeraiAccount?.id) return;
		if (!confirm('Remove your Numerai account credentials?')) return;
		busy = true;
		try {
			await dataClient().models.NumeraiAccount.delete({ id: numeraiAccount.id });
			numeraiAccount = null;
			closeDrawer();
			addToast('Numerai account removed', 'success');
		} catch (e) {
			addToast(asMessage(e, 'Failed to remove Numerai account'), 'error');
		} finally {
			busy = false;
		}
	}

	async function saveProvider(event: Event) {
		event.preventDefault();
		if (!providerForm.name.trim()) {
			addToast('Provider name is required', 'error');
			return;
		}
		let credentialsJson: Record<string, unknown> | null = null;
		if (providerForm.credentialsJson.trim()) {
			try {
				credentialsJson = JSON.parse(providerForm.credentialsJson);
			} catch {
				addToast('Credentials must be valid JSON', 'error');
				return;
			}
		}
		busy = true;
		try {
			const payload = {
				name: providerForm.name.trim(),
				providerType: providerForm.providerType,
				credentialsJson,
				monthlyBudgetUsd: providerForm.monthlyBudgetUsd ? Number(providerForm.monthlyBudgetUsd) : null,
				notes: providerForm.notes.trim() || null
			};
			if (drawer.kind === 'provider') {
				await dataClient().models.ComputeProvider.update({ id: drawer.id, ...payload });
				addToast('Provider updated', 'success');
			} else {
				await dataClient().models.ComputeProvider.create({ status: 'available', ...payload });
				addToast(`${payload.name} added`, 'success');
			}
			await loadProviders();
			closeDrawer();
		} catch (e) {
			addToast(asMessage(e, 'Failed to save provider'), 'error');
		} finally {
			busy = false;
		}
	}

	async function removeProvider() {
		if (drawer.kind !== 'provider') return;
		if (!confirm(`Remove provider “${providerForm.name}”?`)) return;
		busy = true;
		try {
			await dataClient().models.ComputeProvider.delete({ id: drawer.id });
			addToast(`${providerForm.name} removed`, 'success');
			await loadProviders();
			closeDrawer();
		} catch (e) {
			addToast(asMessage(e, 'Failed to remove provider'), 'error');
		} finally {
			busy = false;
		}
	}

	async function addPasskey() {
		busy = true;
		try {
			await registerPasskey();
			addToast('Passkey added', 'success');
			await loadPasskeys();
		} catch (e) {
			addToast(asMessage(e, 'Failed to add passkey'), 'error');
		} finally {
			busy = false;
		}
	}

	async function removePasskey(credentialId: string) {
		if (!confirm('Remove this passkey?')) return;
		busy = true;
		try {
			await deletePasskey(credentialId);
			addToast('Passkey removed', 'success');
			await loadPasskeys();
		} catch (e) {
			addToast(asMessage(e, 'Failed to remove passkey'), 'error');
		} finally {
			busy = false;
		}
	}

	function asMessage(e: unknown, fallback: string) {
		return e instanceof Error ? e.message : fallback;
	}

	function maskSecret(value: string | null | undefined) {
		if (!value) return '';
		if (value.length <= 6) return '••••';
		return `${value.slice(0, 4)}…${value.slice(-2)}`;
	}

	function formatDate(value: string | null | undefined) {
		if (!value) return '—';
		try {
			return new Date(value).toLocaleString();
		} catch {
			return value;
		}
	}
</script>

<svelte:head>
	<title>Settings | Numerai Dashboard</title>
</svelte:head>

<AuthGate>
	<section class="settings-page">
		<div class="flow-shell" class:drawer-open={drawer.kind !== 'none'}>
			<div class="flow-canvas">
				<SvelteFlow
					{nodes}
					{edges}
					{nodeTypes}
					fitView
					proOptions={{ hideAttribution: true }}
					nodesDraggable={false}
					nodesConnectable={false}
					onnodeclick={handleNodeClick}
				>
					<Background patternColor="rgba(23,23,23,0.08)" gap={28} />
					<Controls showLock={false} />
				</SvelteFlow>
			</div>

			{#if drawer.kind !== 'none'}
				<aside class="drawer" aria-label="Edit credentials">
					<header class="drawer-head">
						<div>
							<span class="eyebrow">Edit</span>
							<h2>
								{#if drawer.kind === 'numerai'}Numerai account{/if}
								{#if drawer.kind === 'passkeys'}Passkeys{/if}
								{#if drawer.kind === 'provider'}{providerForm.name || 'Provider'}{/if}
								{#if drawer.kind === 'add-provider'}New compute provider{/if}
							</h2>
						</div>
						<button type="button" class="ghost" onclick={closeDrawer} aria-label="Close">✕</button>
					</header>

					{#if drawer.kind === 'numerai'}
						{#if numeraiAccount}
							<dl class="kv">
								<dt>Public ID</dt>
								<dd class="mono">{numeraiAccount.publicId}</dd>
								<dt>Secret key</dt>
								<dd class="mono">{maskSecret(numeraiAccount.secretKey)}</dd>
								<dt>Last verified</dt>
								<dd>{formatDate(numeraiAccount.verifiedAt)}</dd>
							</dl>
						{/if}
						<form class="form" onsubmit={saveNumerai}>
							<label>
								<span>Label</span>
								<input type="text" bind:value={numeraiForm.label} placeholder="Main account" />
							</label>
							<label>
								<span>Public ID</span>
								<input type="text" bind:value={numeraiForm.publicId} autocomplete="off" required />
							</label>
							<label>
								<span>Secret key {numeraiAccount ? '(leave blank to keep current)' : ''}</span>
								<input type="password" bind:value={numeraiForm.secretKey} autocomplete="off" />
							</label>
							<div class="form-actions">
								<button type="submit" class="primary" disabled={busy}>
									{busy ? 'Saving…' : numeraiAccount ? 'Save changes' : 'Link account'}
								</button>
								{#if numeraiAccount}
									<button type="button" class="danger" onclick={removeNumerai} disabled={busy}>Remove</button>
								{/if}
							</div>
						</form>
					{:else if drawer.kind === 'passkeys'}
						<p class="muted">Use Touch ID, Face ID, or a security key to sign in without a password.</p>
						{#if passkeys.length === 0}
							<p class="muted">No passkeys yet.</p>
						{:else}
							<ul class="rows">
								{#each passkeys as pk (pk.credentialId)}
									<li class="row">
										<div>
											<strong>{pk.friendlyCredentialName ?? 'Passkey'}</strong>
											<span class="muted">added {formatDate(pk.createdAt)}</span>
										</div>
										<button type="button" class="danger" onclick={() => removePasskey(pk.credentialId)} disabled={busy}>
											Remove
										</button>
									</li>
								{/each}
							</ul>
						{/if}
						<div class="form-actions">
							<button type="button" class="primary" onclick={addPasskey} disabled={busy}>
								{busy ? 'Working…' : 'Add passkey'}
							</button>
						</div>
					{:else if drawer.kind === 'provider' || drawer.kind === 'add-provider'}
						<form class="form" onsubmit={saveProvider}>
							<label>
								<span>Name</span>
								<input type="text" bind:value={providerForm.name} placeholder="Prime A100s" required />
							</label>
							<label>
								<span>Type</span>
								<select bind:value={providerForm.providerType}>
									{#each providerTypes as t (t)}
										<option value={t}>{providerLabels[t]}</option>
									{/each}
								</select>
							</label>
							<label>
								<span>Monthly budget (USD)</span>
								<input
									type="number"
									min="0"
									step="0.01"
									bind:value={providerForm.monthlyBudgetUsd}
									placeholder="100"
								/>
							</label>
							<label>
								<span>Credentials (JSON)</span>
								<textarea
									bind:value={providerForm.credentialsJson}
									rows="5"
									placeholder={'{ "apiKey": "..." }'}
								></textarea>
							</label>
							<label>
								<span>Notes</span>
								<input type="text" bind:value={providerForm.notes} placeholder="us-west-2, reserved capacity" />
							</label>
							<div class="form-actions">
								<button type="submit" class="primary" disabled={busy}>
									{busy ? 'Saving…' : drawer.kind === 'provider' ? 'Save changes' : 'Add provider'}
								</button>
								{#if drawer.kind === 'provider'}
									<button type="button" class="danger" onclick={removeProvider} disabled={busy}>Remove</button>
								{/if}
							</div>
						</form>
					{/if}
				</aside>
			{/if}
		</div>
	</section>
</AuthGate>

<style>
	.settings-page {
		display: block;
	}

	.flow-shell {
		position: relative;
		display: grid;
		grid-template-columns: 1fr 0;
		gap: 0;
		transition: grid-template-columns 0.25s ease;
		height: calc(100vh - var(--nav-height, 88px));
		min-height: 480px;
		background: var(--bg-page);
		overflow: hidden;
	}
	.flow-shell.drawer-open { grid-template-columns: 1fr 380px; }

	.flow-canvas {
		min-width: 0;
		background: var(--bg-page);
	}
	.flow-canvas :global(.svelte-flow) {
		background: var(--bg-page);
	}
	.flow-canvas :global(.svelte-flow__controls) {
		border: 1px solid var(--text);
		box-shadow: 2px 2px 0 var(--text);
		background: var(--bg-card);
	}
	.flow-canvas :global(.svelte-flow__controls-button) {
		background: var(--bg-card);
		border-bottom: 1px solid var(--border-light);
		color: var(--text);
	}
	.flow-canvas :global(.svelte-flow__controls-button:hover) {
		background: var(--hover-bg);
	}

	.drawer {
		display: grid;
		grid-template-rows: auto 1fr;
		gap: 1rem;
		padding: 1rem 1.1rem 1.2rem;
		background: var(--bg-card);
		border-left: 1px solid var(--text);
		overflow-y: auto;
	}

	.drawer-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.5rem;
	}
	.drawer-head .eyebrow {
		font-family: var(--font-mono);
		font-size: 0.65rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
		display: block;
		margin-bottom: 0.15rem;
	}
	.drawer-head h2 { margin: 0; font-size: 1.05rem; }

	button {
		font: inherit;
		font-size: 0.82rem;
		font-weight: 700;
		padding: 0.5rem 0.85rem;
		border-radius: 4px;
		border: 1px solid var(--text);
		background: var(--bg-card);
		color: var(--text);
		cursor: pointer;
	}
	button:hover:not(:disabled) { background: var(--hover-bg); }
	button:disabled { opacity: 0.6; cursor: not-allowed; }
	button.primary {
		background: var(--text);
		color: #fff;
	}
	button.primary:hover:not(:disabled) { background: #303030; }
	button.danger {
		color: var(--red);
		border-color: var(--red);
	}
	button.danger:hover:not(:disabled) { background: var(--badge-red); }
	button.ghost {
		border: none;
		background: none;
		font-size: 1rem;
		padding: 0.25rem 0.4rem;
	}

	.muted { color: var(--text-muted); margin: 0; font-size: 0.85rem; }
	.mono { font-family: var(--font-mono); }

	.kv {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.35rem 0.85rem;
		margin: 0 0 0.4rem;
		padding-bottom: 0.7rem;
		border-bottom: 1px solid var(--border-light);
	}
	.kv dt {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.65rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		align-self: center;
	}
	.kv dd { margin: 0; font-size: 0.85rem; }

	.form { display: grid; gap: 0.7rem; }
	.form label {
		display: grid;
		gap: 0.3rem;
		font-size: 0.85rem;
	}
	.form label > span {
		color: var(--text-secondary);
		font-size: 0.74rem;
		font-weight: 700;
	}
	.form input,
	.form select,
	.form textarea {
		font: inherit;
		font-size: 0.88rem;
		padding: 0.5rem 0.65rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-input);
		color: var(--text);
	}
	.form textarea { font-family: var(--font-mono); resize: vertical; }
	.form-actions { display: flex; gap: 0.5rem; margin-top: 0.3rem; }

	.rows { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.4rem; }
	.row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		padding: 0.55rem 0.7rem;
		background: var(--bg-input);
		border: 1px solid var(--border-light);
		border-radius: 4px;
	}
	.row > div { display: grid; gap: 0.1rem; }
	.row strong { font-size: 0.85rem; }
	.row .muted { font-size: 0.74rem; }

	@media (max-width: 880px) {
		.flow-shell {
			grid-template-columns: 1fr;
			height: auto;
		}
		.flow-shell.drawer-open { grid-template-columns: 1fr; }
		.flow-canvas { height: 480px; }
		.drawer { border-left: none; border-top: 1px solid var(--text); }
	}
</style>
