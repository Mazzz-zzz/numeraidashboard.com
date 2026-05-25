import type { Schema } from '../../data/resource';
import { resolvePrimeApiKey } from '../prime-intellect';

type Args = Schema['syncPrimeTemplate']['args'];

export const handler: Schema['syncPrimeTemplate']['functionHandler'] = async (event) => {
	const args = event.arguments;
	const checkedAt = new Date().toISOString();
	const apiKey = await resolvePrimeApiKey({ apiKeyRef: args.apiKeyRef, apiKey: args.apiKey });
	if (!apiKey) return fail('Prime Intellect API key is required', checkedAt);

	const templateName = args.templateName.trim();
	const dockerImage = args.dockerImage?.trim() || null;
	const customTemplateId = args.customTemplateId?.trim() || null;
	const gpuType = args.gpuType?.trim() || 'RTX4090_24GB';
	const maxPrice = typeof args.maxPrice === 'number' && Number.isFinite(args.maxPrice) ? args.maxPrice : null;
	const dryRun = args.dryRun === true;

	if (!templateName) return fail('templateName is required', checkedAt);
	if (!dockerImage && !customTemplateId) {
		return fail('Provide a Docker image or an existing Prime custom template ID', checkedAt);
	}

	if (dockerImage && !dryRun) {
		const err = await checkDockerImage({
			apiKey,
			baseUrl: args.baseUrl,
			image: dockerImage,
			registryCredentialsId: args.registryCredentialsId ?? null,
		});
		if (err) return fail(err, checkedAt);
	}

	return {
		ok: true,
		status: dryRun ? 'validated' : 'synced',
		checkedAt,
		error: null,
		templateName,
		customTemplateId,
		dockerImage,
		providerConfigJson: {
			primeIntellect: {
				templateName,
				customTemplateId,
				dockerImage,
				registryCredentialsId: args.registryCredentialsId ?? null,
				gpuType,
				maxPrice,
				dryRun,
				syncedAt: checkedAt,
			},
		},
	};
};

async function checkDockerImage(input: {
	readonly apiKey: string;
	readonly baseUrl?: string | null;
	readonly image: string;
	readonly registryCredentialsId: string | null;
}): Promise<string | null> {
	const baseUrl = (input.baseUrl ?? '').replace(/\/$/, '') || 'https://api.primeintellect.ai';
	try {
		const resp = await fetch(`${baseUrl}/api/v1/template/check-docker-image`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${input.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				image: input.image,
				registry_credentials_id: input.registryCredentialsId,
			}),
		});
		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			return `Prime Intellect image check failed (${resp.status}): ${text.slice(0, 300)}`;
		}
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

function fail(error: string, checkedAt: string) {
	return {
		ok: false,
		status: 'failed',
		checkedAt,
		error,
		templateName: null,
		customTemplateId: null,
		dockerImage: null,
		providerConfigJson: null,
	};
}
