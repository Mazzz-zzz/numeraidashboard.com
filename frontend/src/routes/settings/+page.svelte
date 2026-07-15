<script lang="ts">
	import { onMount } from 'svelte';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import { authState, getPasskeys, registerPasskey, deletePasskey } from '$lib/auth';
	import { dataClient } from '$lib/data';
	import { addToast } from '$lib/stores';
	import {
		editableCredentialValue,
		preservedCredentialRef,
		settingsCredentialInputType
	} from '$lib/services/settings-credentials';
	import { localDaemonBaseUrl } from '$lib/services/local-training-service';
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
	type ProviderForm = {
		name: string;
		providerType: ProviderType;
		apiKey: string;
		apiSecret: string;
		workspaceId: string;
		awsRoleArn: string;
		awsRegion: string;
		baseUrl: string;
		customTemplateId: string;
		maxPrice: string;
		maxRuntimeMinutes: string;
		diskSize: string;
		monthlyBudgetUsd: string;
		notes: string;
	};
	type ProviderTemplate = {
		id: string;
		name: string;
		nodeLabel: string;
		providerType: ProviderType;
		logoSrc: string;
		defaults: Partial<ProviderForm>;
	};
	type ProviderVerifyPayload = {
		name: string;
		providerType: ProviderType;
		apiKey: string | null;
		apiSecret: string | null;
		apiKeyRef: string | null;
		apiSecretRef: string | null;
		workspaceId: string | null;
		awsRoleArn: string | null;
		awsRegion: string | null;
		baseUrl: string | null;
	};
	type ProviderCheckState = {
		status: 'idle' | 'checking' | 'ok' | 'error';
		message: string;
	};

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
	const providerLogos: Partial<Record<ProviderType, string>> = {
		prime_intellect: '/provider-logos/prime-intellect.png',
		modal: '/provider-logos/modal.svg',
		sagemaker: '/provider-logos/aws.png'
	};
	const providerTemplates: ProviderTemplate[] = [
		{
			id: 'prime-intellect',
			name: 'Prime Intellect',
			nodeLabel: 'Add Prime Intellect',
			providerType: 'prime_intellect',
			logoSrc: '/provider-logos/prime-intellect.png',
			defaults: {
				name: 'Prime Intellect',
				baseUrl: 'https://api.primeintellect.ai',
				notes: 'Paste a Prime Intellect API key. Workspace ID is optional.'
			}
		},
		{
			id: 'modal',
			name: 'Modal',
			nodeLabel: 'Add Modal',
			providerType: 'modal',
			logoSrc: '/provider-logos/modal.svg',
			defaults: {
				name: 'Modal',
				notes: 'Create a Modal token and paste token ID (ak-) plus token secret (as-).'
			}
		},
		{
			id: 'sagemaker',
			name: 'AWS SageMaker',
			nodeLabel: 'Add SageMaker',
			providerType: 'sagemaker',
			logoSrc: '/provider-logos/aws.png',
			defaults: {
				name: 'AWS SageMaker',
				awsRegion: '',
				notes: 'Paste an execution role ARN with SageMaker training permissions.'
			}
		},
		{
			id: 'lambda-cloud',
			name: 'Lambda Cloud',
			nodeLabel: 'Add Lambda Cloud',
			providerType: 'custom',
			logoSrc: '/provider-logos/lambda.svg',
			defaults: {
				name: 'Lambda Cloud',
				baseUrl: 'https://cloud.lambdalabs.com/api/v1',
				notes: 'Stored as a custom provider until Lambda Cloud gets first-class verification.'
			}
		},
		{
			id: 'local',
			name: 'Local (this machine)',
			nodeLabel: 'Add Local',
			providerType: 'local',
			logoSrc: '',
			defaults: {
				name: 'Local (this machine)',
				notes: 'Trains on this machine (Apple Silicon / MPS) via the local daemon, auto-started by npm run dev. Leave Base URL blank to use the built-in /local-daemon proxy.'
			}
		}
	];

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
	let providerForm = $state<ProviderForm>({
		name: '',
		providerType: 'prime_intellect' as ProviderType,
		apiKey: '',
		apiSecret: '',
		workspaceId: '',
		awsRoleArn: '',
		awsRegion: '',
		baseUrl: '',
		customTemplateId: '',
		maxPrice: '',
		maxRuntimeMinutes: '180',
		diskSize: '80',
		monthlyBudgetUsd: '',
		notes: ''
	});
	let providerCheck = $state<ProviderCheckState>({ status: 'idle', message: 'Not tested' });
	let verifiedProviderRefs = $state<{ apiKeyRef: string | null; apiSecretRef: string | null } | null>(null);
	let busy = $state(false);
	let verifying = $state(false);

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

	const availableProviderTemplates = $derived(providerTemplates.filter((template) => !providerTemplateInstalled(template)));
	const nodes = $derived<Node[]>(buildNodes());
	const edges = $derived<Edge[]>(buildEdges());

	function providerTemplateInstalled(template: ProviderTemplate): boolean {
		return providers.some((provider) => {
			const providerType = provider.providerType as ProviderType | null;
			if (template.providerType !== 'custom') return providerType === template.providerType;
			return providerType === 'custom' && (provider.name ?? '').trim().toLowerCase() === template.name.toLowerCase();
		});
	}

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
					sub: providerStatusLabel(p),
					logoSrc: providerLogoFor(p),
					linked: !!p.verifiedAt && !p.lastVerifyError
				}
			});
		});
		availableProviderTemplates.forEach((template, i) => {
			out.push({
				id: providerTemplateNodeId(template),
				type: 'add',
				position: { x: 720, y: providerYStart + (providers.length + i) * providerYStep },
				data: {
					label: template.nodeLabel,
					logoSrc: template.logoSrc
				}
			});
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
				animated: !!p.verifiedAt && !p.lastVerifyError,
				style: 'stroke: var(--text); stroke-width: 1.4;'
			});
		});
		availableProviderTemplates.forEach((template) => {
			out.push({
				id: `e-hub-${template.id}`,
				source: 'hub',
				target: providerTemplateNodeId(template),
				type: 'smoothstep',
				style: 'stroke: var(--text); stroke-width: 1.2; stroke-dasharray: 4 4;'
			});
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
		} else if (node.id.startsWith('add-provider-')) {
			const template = availableProviderTemplates.find((candidate) => providerTemplateNodeId(candidate) === node.id);
			if (template) {
				applyProviderTemplate(template);
				providerCheck = { status: 'idle', message: 'Not tested' };
				verifiedProviderRefs = null;
				drawer = { kind: 'add-provider' };
			}
		} else if (node.type === 'provider') {
			const id = node.id.replace(/^provider-/, '');
			const p = providers.find((pp) => pp.id === id);
			if (p) {
				const prime = primeProviderConfig(p.credentialsJson);
				providerForm = {
					name: p.name,
					providerType: (p.providerType as ProviderType) ?? 'custom',
					apiKey: '',
					apiSecret: '',
					workspaceId: p.workspaceId ?? '',
					awsRoleArn: p.awsRoleArn ?? '',
					awsRegion: p.awsRegion ?? '',
					baseUrl: p.baseUrl ?? '',
					customTemplateId: stringValue(prime.customTemplateId),
					maxPrice: numberString(prime.maxPrice),
					maxRuntimeMinutes: numberString(prime.maxRuntimeMinutes) || '180',
					diskSize: numberString(prime.diskSize) || '80',
					monthlyBudgetUsd: p.monthlyBudgetUsd != null ? String(p.monthlyBudgetUsd) : '',
					notes: p.notes ?? ''
				};
				providerCheck = providerCheckStateFor(p);
				verifiedProviderRefs = null;
				drawer = { kind: 'provider', id };
			}
		}
	}

	function blankProviderForm() {
		return {
			name: '',
			providerType: 'prime_intellect' as ProviderType,
			apiKey: '',
			apiSecret: '',
			workspaceId: '',
			awsRoleArn: '',
			awsRegion: '',
			baseUrl: '',
			customTemplateId: '',
			maxPrice: '',
			maxRuntimeMinutes: '180',
			diskSize: '80',
			monthlyBudgetUsd: '',
			notes: ''
		};
	}

	function providerLogoFor(provider: ComputeProvider): string | null {
		const providerType = provider.providerType as ProviderType | null;
		if (providerType === 'custom') {
			const haystack = `${provider.name ?? ''} ${provider.baseUrl ?? ''}`.toLowerCase();
			if (haystack.includes('lambda')) return '/provider-logos/lambda.svg';
		}
		return providerType ? providerLogos[providerType] ?? null : null;
	}

	function providerStatusLabel(provider: ComputeProvider): string {
		if (provider.lastVerifyError) return 'connection failed';
		if (provider.verifiedAt) return `verified ${formatDate(provider.verifiedAt)}`;
		return 'not verified';
	}

	function providerCheckStateFor(provider: ComputeProvider): ProviderCheckState {
		if (provider.lastVerifyError) return { status: 'error', message: provider.lastVerifyError };
		if (provider.verifiedAt) return { status: 'ok', message: `Verified ${formatDate(provider.verifiedAt)}` };
		return { status: 'idle', message: 'Not tested' };
	}

	function providerPayloadFromForm(): ProviderVerifyPayload {
		return {
			name: providerForm.name.trim(),
			providerType: providerForm.providerType,
			apiKey: editableCredentialValue(providerForm.apiKey),
			apiSecret: editableCredentialValue(providerForm.apiSecret),
			apiKeyRef: preservedCredentialRef(currentProvider?.apiKeyRef, verifiedProviderRefs?.apiKeyRef),
			apiSecretRef: preservedCredentialRef(currentProvider?.apiSecretRef, verifiedProviderRefs?.apiSecretRef),
			workspaceId: providerForm.workspaceId.trim() || null,
			awsRoleArn: providerForm.awsRoleArn.trim() || null,
			awsRegion: providerForm.awsRegion.trim() || null,
			baseUrl: providerForm.baseUrl.trim() || null
		};
	}

	function providerConfigJsonFromForm() {
		if (drawer.kind !== 'provider' && drawer.kind !== 'add-provider') return null;
		const existing = currentProvider?.providerType === providerForm.providerType
			? jsonRecord(currentProvider.credentialsJson)
			: {};
		if (providerForm.providerType !== 'prime_intellect') return currentProvider?.credentialsJson ?? null;
		const oldPrime = primeProviderConfig(existing);
		const { customTemplateId: _oldTemplate, maxPrice: _oldMaxPrice, ...primeWithoutOverrides } = oldPrime;
		const { prime_intellect: _oldSnakeCase, primeIntellect: _oldCamelCase, ...root } = existing;
		return {
			...root,
			primeIntellect: {
				...primeWithoutOverrides,
				...(providerForm.customTemplateId.trim() ? { customTemplateId: providerForm.customTemplateId.trim() } : {}),
				...(providerForm.maxPrice ? { maxPrice: Number(providerForm.maxPrice) } : {}),
				maxRuntimeMinutes: Number(providerForm.maxRuntimeMinutes) || 180,
				diskSize: Number(providerForm.diskSize) || 80
			}
		};
	}

	function jsonRecord(value: unknown): Record<string, unknown> {
		if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
		if (typeof value !== 'string') return {};
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	}

	function primeProviderConfig(value: unknown): Record<string, unknown> {
		const root = jsonRecord(value);
		const nested = root.primeIntellect ?? root.prime_intellect;
		return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : {};
	}

	function stringValue(value: unknown): string {
		return typeof value === 'string' ? value : '';
	}

	function numberString(value: unknown): string {
		return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
	}

	function markProviderCheckDirty() {
		if (providerCheck.status === 'checking') return;
		providerCheck = { status: 'idle', message: 'Edited since last check' };
		verifiedProviderRefs = null;
	}

	function applyProviderTemplate(template: ProviderTemplate) {
		providerForm = {
			...blankProviderForm(),
			providerType: template.providerType,
			...template.defaults
		};
	}

	function providerTemplateNodeId(template: ProviderTemplate) {
		return `add-provider-${template.id}`;
	}

	function closeDrawer() {
		drawer = { kind: 'none' };
		verifiedProviderRefs = null;
	}

	async function saveNumerai(event: Event) {
		event.preventDefault();
		if (!numeraiForm.publicId.trim() || (!numeraiForm.secretKey.trim() && !numeraiAccount)) {
			addToast('Public ID and secret key are required', 'error');
			return;
		}
		busy = true;
		try {
			const publicId = numeraiForm.publicId.trim();
			const { data, errors } = await dataClient().mutations.verifyNumeraiAccount({
				publicId,
				secretKey: editableCredentialValue(numeraiForm.secretKey),
				secretRef: numeraiAccount?.secretRef ?? null
			});
			if (errors?.length) throw new Error(errors[0].message);
			if (!data?.secretRef) throw new Error(data?.error ?? 'Numerai secret reference was not created');
			const payload = {
				publicId,
				secretRef: data.secretRef,
				label: numeraiForm.label.trim() || undefined,
				verifiedAt: data.ok ? data.verifiedAt ?? new Date().toISOString() : null,
				lastVerifyError: data.ok ? null : data.error ?? 'unknown error'
			};
			if (numeraiAccount?.id) {
				const updated = await dataClient().models.NumeraiAccount.update({ id: numeraiAccount.id, ...payload });
				numeraiAccount = updated.data as NumeraiAccount;
			} else {
				const created = await dataClient().models.NumeraiAccount.create(payload);
				numeraiAccount = created.data as NumeraiAccount;
			}
			addToast(data.ok ? 'Numerai account saved and verified' : `Numerai saved; verify failed: ${data.error ?? 'unknown error'}`, data.ok ? 'success' : 'error');
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
		busy = true;
		try {
			const providerPayload = providerPayloadFromForm();
			const payload = {
				name: providerPayload.name,
				providerType: providerPayload.providerType,
				apiKeyRef: providerPayload.apiKeyRef,
				apiSecretRef: providerPayload.apiSecretRef,
				workspaceId: providerPayload.workspaceId,
				awsRoleArn: providerPayload.awsRoleArn,
				awsRegion: providerPayload.awsRegion,
				baseUrl: providerPayload.baseUrl,
				credentialsJson: providerConfigJsonFromForm(),
				monthlyBudgetUsd: providerForm.monthlyBudgetUsd ? Number(providerForm.monthlyBudgetUsd) : null,
				notes: providerForm.notes.trim() || null
			};
			// Local runs on this machine via the daemon — there is no cloud
			// endpoint to verify, so mark it available without a verify round-trip.
			const isLocal = providerPayload.providerType === 'local';
			if (drawer.kind === 'provider') {
				const verified = isLocal ? null : await verifyProviderConnection(drawer.id, providerPayload);
				await dataClient().models.ComputeProvider.update({
					id: drawer.id,
					...payload,
					apiKeyRef: verified?.apiKeyRef ?? providerPayload.apiKeyRef,
					apiSecretRef: verified?.apiSecretRef ?? providerPayload.apiSecretRef,
					verifiedAt: isLocal
						? new Date().toISOString()
						: verified?.ok
							? verified.verifiedAt ?? new Date().toISOString()
							: null,
					lastVerifyError: isLocal ? null : verified?.ok ? null : verified?.error ?? 'unknown error'
				});
			} else {
				const verified = isLocal ? null : await verifyProviderConnection(null, providerPayload);
				const { data } = await dataClient().models.ComputeProvider.create({
					status: 'available',
					...payload,
					apiKeyRef: verified?.apiKeyRef ?? providerPayload.apiKeyRef,
					apiSecretRef: verified?.apiSecretRef ?? providerPayload.apiSecretRef,
					verifiedAt: isLocal
						? new Date().toISOString()
						: verified?.ok
							? verified.verifiedAt ?? new Date().toISOString()
							: null,
					lastVerifyError: isLocal ? null : verified?.ok ? null : verified?.error ?? 'unknown error'
				});
				if (data?.id && !isLocal && !verified?.ok) {
					await dataClient().models.ComputeProvider.update({
						id: data.id,
						lastVerifyError: verified?.error ?? 'unknown error'
					});
				}
			}
			if (isLocal) addToast(`${providerPayload.name} saved`, 'success');
			await loadProviders();
			closeDrawer();
		} catch (e) {
			addToast(asMessage(e, 'Failed to save provider'), 'error');
		} finally {
			busy = false;
		}
	}

	async function verifyProviderConnection(
		id: string | null,
		payload: ProviderVerifyPayload
	): Promise<NonNullable<Schema['VerifyResult']['type']>> {
		providerCheck = { status: 'checking', message: 'Checking connection...' };
		const { data, errors } = await dataClient().mutations.verifyComputeProvider({
			providerType: payload.providerType,
			apiKey: payload.apiKey,
			apiSecret: payload.apiSecret,
			apiKeyRef: payload.apiKeyRef,
			apiSecretRef: payload.apiSecretRef,
			workspaceId: payload.workspaceId,
			awsRoleArn: payload.awsRoleArn,
			awsRegion: payload.awsRegion,
			baseUrl: payload.baseUrl
		});
		if (errors?.length) throw new Error(errors[0].message);
		if (!data) throw new Error('Provider verification returned no data');
		const ok = !!data?.ok;
		const verifiedAt = data?.verifiedAt ?? new Date().toISOString();
		const error = data?.error ?? 'unknown error';
		verifiedProviderRefs = {
			apiKeyRef: data?.apiKeyRef ?? payload.apiKeyRef,
			apiSecretRef: data?.apiSecretRef ?? payload.apiSecretRef
		};
		if (id) {
			await dataClient().models.ComputeProvider.update({
				id,
				verifiedAt: ok ? verifiedAt : null,
				lastVerifyError: ok ? null : error,
				apiKeyRef: data?.apiKeyRef ?? payload.apiKeyRef,
				apiSecretRef: data?.apiSecretRef ?? payload.apiSecretRef
			});
		}
		providerCheck = ok ? { status: 'ok', message: `Verified ${formatDate(verifiedAt)}` } : { status: 'error', message: error };
		addToast(
			ok ? `${payload.name} connection verified` : `${payload.name} verify failed: ${error}`,
			ok ? 'success' : 'error'
		);
		return data as NonNullable<Schema['VerifyResult']['type']>;
	}

	async function testProviderFormConnection() {
		if (!providerForm.name.trim()) {
			addToast('Provider name is required', 'error');
			return;
		}
		verifying = true;
		try {
			if (providerForm.providerType === 'local') {
				await testLocalDaemon();
				return;
			}
			await verifyProviderConnection(drawer.kind === 'provider' ? drawer.id : null, providerPayloadFromForm());
			if (drawer.kind === 'provider') await loadProviders();
		} catch (e) {
			const message = asMessage(e, 'Verification failed');
			providerCheck = { status: 'error', message };
			addToast(message, 'error');
		} finally {
			verifying = false;
		}
	}

	async function testLocalDaemon() {
		providerCheck = { status: 'checking', message: 'Pinging local daemon...' };
		try {
			const base = localDaemonBaseUrl({ baseUrl: providerForm.baseUrl.trim() || null });
			const resp = await fetch(`${base}/health`);
			const body = (await resp.json()) as { ok?: boolean; device?: string };
			if (!resp.ok || !body?.ok) throw new Error('daemon did not report healthy');
			const message = `Daemon healthy (device: ${body.device ?? 'unknown'})`;
			providerCheck = { status: 'ok', message };
			addToast(message, 'success');
		} catch (e) {
			const message = `Local daemon unreachable — start it with "npm run dev" (${asMessage(e, 'no response')})`;
			providerCheck = { status: 'error', message };
			addToast(message, 'error');
		}
	}

	async function verifyNumerai() {
		if (!numeraiAccount?.id || !numeraiAccount.publicId || !numeraiAccount.secretRef) {
			addToast('Save credentials before verifying', 'error');
			return;
		}
		verifying = true;
		try {
			const { data, errors } = await dataClient().mutations.verifyNumeraiAccount({
				publicId: numeraiAccount.publicId,
				secretRef: numeraiAccount.secretRef
			});
			if (errors?.length) throw new Error(errors[0].message);
			const ok = !!data?.ok;
			await dataClient().models.NumeraiAccount.update({
				id: numeraiAccount.id,
				verifiedAt: ok ? data?.verifiedAt ?? new Date().toISOString() : null,
				lastVerifyError: ok ? null : data?.error ?? 'unknown error',
				secretRef: data?.secretRef ?? numeraiAccount.secretRef
			});
			addToast(ok ? 'Numerai credentials verified' : `Verify failed: ${data?.error ?? 'unknown error'}`, ok ? 'success' : 'error');
			await loadNumerai();
		} catch (e) {
			addToast(asMessage(e, 'Verification failed'), 'error');
		} finally {
			verifying = false;
		}
	}

	async function verifyProvider() {
		if (drawer.kind !== 'provider') return;
		const id = drawer.id;
		const p = providers.find((pp) => pp.id === id);
		if (!p) return;
		verifying = true;
		try {
			await verifyProviderConnection(id, {
				name: p.name,
				providerType: (p.providerType as ProviderType) ?? 'custom',
				apiKey: null,
				apiSecret: null,
				apiKeyRef: p.apiKeyRef ?? null,
				apiSecretRef: p.apiSecretRef ?? null,
				workspaceId: p.workspaceId ?? null,
				awsRoleArn: p.awsRoleArn ?? null,
				awsRegion: p.awsRegion ?? null,
				baseUrl: p.baseUrl ?? null
			});
			await loadProviders();
		} catch (e) {
			addToast(asMessage(e, 'Verification failed'), 'error');
		} finally {
			verifying = false;
		}
	}

	const currentProvider = $derived.by(() => {
		if (drawer.kind !== 'provider') return null;
		const id = drawer.id;
		return providers.find((p) => p.id === id) ?? null;
	});

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
								{#if drawer.kind === 'add-provider'}Add {providerForm.name || 'compute provider'}{/if}
							</h2>
						</div>
						<button type="button" class="ghost" onclick={closeDrawer} aria-label="Close">✕</button>
					</header>

					<div class="drawer-body">
						{#if drawer.kind === 'numerai'}
							{#if numeraiAccount}
								<dl class="kv">
									<dt>Public ID</dt>
									<dd class="mono">{numeraiAccount.publicId}</dd>
									<dt>Secret key</dt>
									<dd class="mono">{maskSecret(numeraiAccount.secretRef)}</dd>
									<dt>Status</dt>
									<dd>
										{#if numeraiAccount.lastVerifyError}
											<span class="status-bad">failed</span>
											<span class="muted">{numeraiAccount.lastVerifyError}</span>
										{:else if numeraiAccount.verifiedAt}
											<span class="status-ok">verified</span>
											<span class="muted">{formatDate(numeraiAccount.verifiedAt)}</span>
										{:else}
											<span class="status-unknown">not verified</span>
										{/if}
									</dd>
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
									<input type={settingsCredentialInputType('numeraiApiSecret')} bind:value={numeraiForm.secretKey} autocomplete="off" />
								</label>
								<div class="form-actions">
									<button type="submit" class="primary" disabled={busy}>
										{busy ? 'Saving…' : numeraiAccount ? 'Save changes' : 'Link account'}
									</button>
									{#if numeraiAccount}
										<div class="secondary-row">
											<button type="button" onclick={verifyNumerai} disabled={busy || verifying}>
												{verifying ? 'Verifying…' : 'Verify'}
											</button>
											<button type="button" class="danger" onclick={removeNumerai} disabled={busy}>Remove</button>
										</div>
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
							{#if drawer.kind === 'provider' && currentProvider}
								<dl class="kv">
									<dt>Status</dt>
									<dd>
										{#if currentProvider.lastVerifyError}
											<span class="status-bad">failed</span>
											<span class="muted">{currentProvider.lastVerifyError}</span>
										{:else if currentProvider.verifiedAt}
											<span class="status-ok">verified</span>
											<span class="muted">{formatDate(currentProvider.verifiedAt)}</span>
										{:else}
											<span class="status-unknown">not verified</span>
										{/if}
									</dd>
									<dt>API key ref</dt>
									<dd class="mono">{maskSecret(currentProvider.apiKeyRef)}</dd>
									<dt>API secret ref</dt>
									<dd class="mono">{maskSecret(currentProvider.apiSecretRef)}</dd>
								</dl>
							{/if}
							<form class="form" onsubmit={saveProvider} oninput={markProviderCheckDirty}>
								{#if drawer.kind === 'provider'}
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
								{/if}

								{#if providerForm.providerType === 'prime_intellect'}
									<label>
										<span>API key {currentProvider?.apiKeyRef ? '(leave blank to keep current)' : ''}</span>
										<input type={settingsCredentialInputType('primeIntellectApiKey')} bind:value={providerForm.apiKey} autocomplete="off" placeholder="pit_…" />
									</label>
									<label>
										<span>Workspace ID (optional)</span>
										<input type="text" bind:value={providerForm.workspaceId} placeholder="ws_…" />
									</label>
									<p class="field-note"><strong>Worker template:</strong> Managed Numerai worker (automatic)</p>
									<details class="advanced-fields">
										<summary>Advanced Prime settings</summary>
										<label>
											<span>Custom template ID (optional override)</span>
											<input type="text" bind:value={providerForm.customTemplateId} placeholder="Leave blank to use the managed worker" />
										</label>
										<label>
											<span>Maximum hourly price (USD)</span>
											<input type="number" min="0" step="0.01" bind:value={providerForm.maxPrice} placeholder="No provider-specific cap" />
										</label>
										<label>
											<span>Maximum runtime (minutes)</span>
											<input type="number" min="5" max="1440" step="5" bind:value={providerForm.maxRuntimeMinutes} />
										</label>
										<label>
											<span>Disk size (GB)</span>
											<input type="number" min="20" step="10" bind:value={providerForm.diskSize} />
										</label>
										<label>
											<span>Base URL (optional override)</span>
											<input type="text" bind:value={providerForm.baseUrl} placeholder="https://api.primeintellect.ai" />
										</label>
									</details>
								{:else if providerForm.providerType === 'modal'}
									<label>
										<span>Token ID {currentProvider?.apiKeyRef ? '(leave blank to keep current)' : ''}</span>
										<input type={settingsCredentialInputType('modalTokenId')} bind:value={providerForm.apiKey} autocomplete="off" placeholder="ak-…" />
									</label>
									<label>
										<span>Token secret {currentProvider?.apiSecretRef ? '(leave blank to keep current)' : ''}</span>
										<input type={settingsCredentialInputType('modalTokenSecret')} bind:value={providerForm.apiSecret} autocomplete="off" placeholder="as-…" />
									</label>
								{:else if providerForm.providerType === 'sagemaker'}
									<label>
										<span>Execution role ARN</span>
										<input type="text" bind:value={providerForm.awsRoleArn} placeholder="arn:aws:iam::123456789012:role/SageMakerRole" />
									</label>
									<label>
										<span>AWS region</span>
										<input type="text" bind:value={providerForm.awsRegion} placeholder="e.g. us-east-1" />
									</label>
								{:else if providerForm.providerType === 'local'}
									<p class="field-note">
										Runs on this machine via the local daemon (auto-started by <code>npm run dev</code>).
										No credentials or verification needed.
									</p>
									<label>
										<span>Base URL (optional — blank uses the /local-daemon proxy)</span>
										<input type="text" bind:value={providerForm.baseUrl} placeholder="http://127.0.0.1:8787" />
									</label>
								{:else if providerForm.providerType === 'custom'}
									<label>
										<span>API key {currentProvider?.apiKeyRef ? '(leave blank to keep current)' : '(optional)'}</span>
										<input type={settingsCredentialInputType('customApiKey')} bind:value={providerForm.apiKey} autocomplete="off" />
									</label>
									<label>
										<span>Base URL</span>
										<input type="text" bind:value={providerForm.baseUrl} placeholder="https://…" />
									</label>
								{/if}

								{#if drawer.kind === 'provider'}
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
								{/if}
								<label>
									<span>Notes</span>
									<input type="text" bind:value={providerForm.notes} placeholder="us-west-2, reserved capacity" />
								</label>
								<div class="connection-check" class:ok={providerCheck.status === 'ok'} class:error={providerCheck.status === 'error'}>
									<span class="connection-dot" aria-hidden="true"></span>
									<div>
										<strong>Connection</strong>
										<span>{providerCheck.message}</span>
									</div>
									<button type="button" onclick={testProviderFormConnection} disabled={busy || verifying}>
										{verifying ? 'Checking...' : 'Test connection'}
									</button>
								</div>
								<div class="form-actions">
									<button type="submit" class="primary" disabled={busy}>
										{busy ? 'Saving…' : drawer.kind === 'provider' ? 'Save changes' : 'Add provider'}
									</button>
									{#if drawer.kind === 'provider'}
										<div class="secondary-row">
											<button type="button" class="danger" onclick={removeProvider} disabled={busy}>Remove</button>
										</div>
									{/if}
								</div>
							</form>
						{/if}
					</div>
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
		--drawer-width: clamp(520px, 44vw, 760px);
		grid-template-columns: 1fr;
		gap: 0;
		height: calc(100vh - var(--nav-height, 88px));
		min-height: 480px;
		background: var(--bg-page);
		overflow: hidden;
	}

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
		position: absolute;
		inset: 12px 12px 12px auto;
		z-index: 10;
		display: grid;
		grid-template-rows: auto 1fr;
		width: var(--drawer-width);
		max-width: calc(100% - 24px);
		min-width: 0;
		height: calc(100% - 24px);
		min-height: 0;
		padding: 1.25rem 1.25rem 1.4rem;
		background: var(--bg-card);
		border: 1.5px solid var(--text);
		box-shadow: -4px 4px 0 var(--text);
		overflow: hidden;
	}

		.drawer-body {
			display: grid;
			align-content: start;
			gap: 1.1rem;
			min-width: 0;
			min-height: 0;
			margin-top: -4px;
			margin-left: -4px;
			overflow-x: hidden;
			overflow-y: auto;
			padding: 4px 0.4rem 6px 4px;
		}

	.drawer-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.5rem;
		padding-bottom: 0.9rem;
		margin-bottom: 1.1rem;
		border-bottom: 1.5px solid var(--text);
		min-width: 0;
	}
	.drawer-head > div { min-width: 0; }
	.drawer-head .eyebrow {
		font-family: var(--font-mono);
		font-size: 0.66rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text-muted);
		display: block;
		margin-bottom: 0.3rem;
	}
	.drawer-head h2 {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 700;
		letter-spacing: -0.005em;
	}
	.drawer-head .ghost {
		margin-top: -0.25rem;
	}

	button {
		font: inherit;
		font-size: 0.82rem;
		font-weight: 700;
		min-height: 38px;
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

	.field-note {
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.4;
		opacity: 0.75;
	}
	.field-note code {
		font-size: 0.8rem;
	}
	.advanced-fields {
		display: grid;
		gap: 0.8rem;
		padding: 0.75rem;
		border: 1px solid var(--border-light);
		border-radius: 4px;
	}
	.advanced-fields summary {
		cursor: pointer;
		font-size: 0.8rem;
		font-weight: 700;
	}
	.advanced-fields[open] summary { margin-bottom: 0.8rem; }
	.advanced-fields label { margin-top: 0.65rem; }

	.connection-check {
		display: grid;
		grid-template-columns: 10px minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.65rem;
		min-width: 0;
		min-height: 58px;
		padding: 0.65rem 0.75rem;
		background: var(--bg-page);
		border: 1.5px solid var(--text);
		border-radius: 4px;
	}
	.connection-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-muted);
	}
	.connection-check.ok .connection-dot {
		background: var(--green);
		box-shadow: 0 0 0 2px rgba(26, 127, 55, 0.18);
	}
	.connection-check.error .connection-dot {
		background: var(--red);
		box-shadow: 0 0 0 2px rgba(207, 34, 46, 0.14);
	}
	.connection-check > div {
		display: grid;
		gap: 0.15rem;
		min-width: 0;
	}
	.connection-check strong {
		font-size: 0.84rem;
		font-weight: 720;
	}
	.connection-check span {
		color: var(--text-secondary);
		font-size: 0.74rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.connection-check button {
		white-space: nowrap;
	}

	.muted { color: var(--text-muted); margin: 0; font-size: 0.85rem; }
	.mono { font-family: var(--font-mono); }

	.status-ok,
	.status-bad,
	.status-unknown {
		font-family: var(--font-mono);
		font-size: 0.65rem;
		font-weight: 800;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		padding: 0.15rem 0.4rem;
		margin-right: 0.4rem;
		border: 1px solid currentColor;
		border-radius: 3px;
	}
	.status-ok { color: var(--green, #1f7a3a); }
	.status-bad { color: var(--red); }
	.status-unknown { color: var(--text-muted); }

	.kv {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.5rem 0.85rem;
		margin: 0;
		padding: 0.8rem 0.85rem;
		min-width: 0;
		background: var(--bg-page);
		border: 1.5px solid var(--text);
		border-radius: 4px;
		box-shadow: 3px 3px 0 var(--text);
	}
	.kv dt {
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: 0.62rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		align-self: center;
	}
	.kv dd {
		min-width: 0;
		margin: 0;
		font-size: 0.85rem;
		overflow-wrap: anywhere;
	}

	.form {
		display: grid;
		gap: 0.85rem;
		min-width: 0;
	}
	.form label {
		display: grid;
		gap: 0.35rem;
		min-width: 0;
		font-size: 0.85rem;
	}
	.form label > span {
		font-family: var(--font-mono);
		color: var(--text-muted);
		font-size: 0.62rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		padding-left: 0.75rem;
	}
	.form input,
	.form select {
		font: inherit;
		font-size: 0.9rem;
		width: 100%;
		height: 42px;
		min-width: 0;
		box-sizing: border-box;
		padding: 0.6rem 0.75rem;
		border: 1.5px solid var(--text);
		border-radius: 4px;
		background: var(--bg-page);
		color: var(--text);
		transition: box-shadow 0.12s ease, transform 0.12s ease;
	}
	.form input:hover,
	.form select:hover {
		background: var(--bg-card);
	}
	.form input:focus,
	.form select:focus {
		outline: none;
		box-shadow: 3px 3px 0 var(--text);
		transform: translate(-1px, -1px);
		background: var(--bg-card);
	}
	.form input::placeholder {
		color: var(--text-muted);
		opacity: 0.7;
	}

	.form-actions {
		display: grid;
		gap: 0.5rem;
		margin-top: 0.6rem;
		padding-top: 0.9rem;
		border-top: 1.5px solid var(--text);
	}
	.form-actions .primary {
		width: 100%;
		padding: 0.7rem 0.85rem;
		font-size: 0.88rem;
		box-shadow: 3px 3px 0 var(--text);
		transition: transform 0.12s ease, box-shadow 0.12s ease;
	}
	.form-actions .primary:hover:not(:disabled) {
		transform: translate(-1px, -1px);
		box-shadow: 4px 4px 0 var(--text);
	}
	.form-actions .secondary-row {
		display: flex;
		gap: 0.5rem;
	}
	.form-actions .secondary-row > button {
		flex: 1;
		min-width: 0;
	}

	.rows {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.45rem;
		min-width: 0;
	}
	.row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		min-height: 58px;
		padding: 0.65rem 0.8rem;
		background: var(--bg-page);
		border: 1.5px solid var(--text);
		border-radius: 4px;
	}
	.row > div {
		display: grid;
		gap: 0.15rem;
		min-width: 0;
	}
	.row strong {
		font-size: 0.88rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row .muted { font-size: 0.72rem; font-family: var(--font-mono); }

	@media (max-width: 880px) {
		.flow-shell {
			grid-template-columns: 1fr;
			height: calc(100vh - var(--nav-height, 88px));
			min-height: 560px;
		}
		.flow-canvas { height: 100%; }
		.drawer {
			inset: 10px;
			width: auto;
			max-width: none;
			height: auto;
		}
	}
</style>
