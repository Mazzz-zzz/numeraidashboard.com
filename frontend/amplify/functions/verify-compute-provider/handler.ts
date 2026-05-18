import type { Schema } from '../../data/resource';

type Args = Schema['verifyComputeProvider']['args'];
type Result = { ok: boolean; verifiedAt: string | null; error: string | null };

export const handler: Schema['verifyComputeProvider']['functionHandler'] = async (event) => {
	const err = await verifyByType(event.arguments);
	if (err) return { ok: false, verifiedAt: null, error: err };
	return { ok: true, verifiedAt: new Date().toISOString(), error: null };
};

async function verifyByType(a: Args): Promise<string | null> {
	switch (a.providerType) {
		case 'prime_intellect':
			return verifyPrimeIntellect(a);
		case 'modal':
			return verifyModal(a);
		case 'sagemaker':
			return verifySagemaker(a);
		case 'local':
			return null;
		case 'custom':
			return a.apiKey || a.baseUrl ? null : 'Custom provider needs at least apiKey or baseUrl';
		default:
			return `Unknown provider type: ${a.providerType}`;
	}
}

async function verifyPrimeIntellect(a: Args): Promise<string | null> {
	if (!a.apiKey) return 'apiKey is required';
	const base = (a.baseUrl ?? '').replace(/\/$/, '') || 'https://api.primeintellect.ai';
	try {
		const resp = await fetch(`${base}/api/v1/me`, {
			headers: { Authorization: `Bearer ${a.apiKey}` },
		});
		if (resp.status === 404) return null;
		if (!resp.ok) return `Prime Intellect responded ${resp.status}`;
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

async function verifyModal(a: Args): Promise<string | null> {
	if (!a.apiKey || !a.apiSecret) return 'Modal needs token id (apiKey) and token secret (apiSecret)';
	if (!a.apiKey.startsWith('ak-')) return 'Modal token id should start with "ak-"';
	if (!a.apiSecret.startsWith('as-')) return 'Modal token secret should start with "as-"';
	return null;
}

async function verifySagemaker(a: Args): Promise<string | null> {
	if (!a.awsRoleArn) return 'awsRoleArn is required';
	if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/.test(a.awsRoleArn))
		return 'awsRoleArn does not look like a valid IAM role ARN';
	if (!a.awsRegion) return 'awsRegion is required';
	return null;
}
