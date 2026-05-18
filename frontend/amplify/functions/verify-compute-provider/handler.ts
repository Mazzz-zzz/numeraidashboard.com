import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/verify-compute-provider';

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

type VerifyResult = { ok: boolean; verifiedAt: string | null; error: string | null };

export const handler: Schema['verifyComputeProvider']['functionHandler'] = async (event) => {
	const id = event.arguments.id;
	const owner = event.identity && 'sub' in event.identity ? `${event.identity.sub}::${event.identity.username}` : null;

	const { data: row, errors } = await client.models.ComputeProvider.get({ id });
	if (errors?.length || !row) {
		return fail('Provider not found');
	}
	if (owner && row.owner && row.owner !== owner) {
		return fail('Not authorized');
	}

	const verifyError = await verifyByType(row);

	const now = new Date().toISOString();
	if (verifyError) {
		await client.models.ComputeProvider.update({ id, verifiedAt: null, lastVerifyError: verifyError });
		return { ok: false, verifiedAt: null, error: verifyError } satisfies VerifyResult;
	}
	await client.models.ComputeProvider.update({ id, verifiedAt: now, lastVerifyError: null });
	return { ok: true, verifiedAt: now, error: null } satisfies VerifyResult;
};

type Row = NonNullable<Awaited<ReturnType<typeof client.models.ComputeProvider.get>>['data']>;

async function verifyByType(row: Row): Promise<string | null> {
	switch (row.providerType) {
		case 'prime_intellect':
			return verifyPrimeIntellect(row);
		case 'modal':
			return verifyModal(row);
		case 'sagemaker':
			return verifySagemaker(row);
		case 'local':
			return null;
		case 'custom':
			return row.apiKey || row.baseUrl ? null : 'Custom provider needs at least apiKey or baseUrl';
		default:
			return 'Unknown provider type';
	}
}

async function verifyPrimeIntellect(row: Row): Promise<string | null> {
	if (!row.apiKey) return 'apiKey is required';
	const base = row.baseUrl?.replace(/\/$/, '') || 'https://api.primeintellect.ai';
	try {
		const resp = await fetch(`${base}/api/v1/me`, {
			headers: { Authorization: `Bearer ${row.apiKey}` },
		});
		if (resp.status === 404) return null;
		if (!resp.ok) return `Prime Intellect responded ${resp.status}`;
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

async function verifyModal(row: Row): Promise<string | null> {
	if (!row.apiKey || !row.apiSecret) return 'Modal needs token id (apiKey) and token secret (apiSecret)';
	if (!row.apiKey.startsWith('ak-')) return 'Modal token id should start with "ak-"';
	if (!row.apiSecret.startsWith('as-')) return 'Modal token secret should start with "as-"';
	return null;
}

async function verifySagemaker(row: Row): Promise<string | null> {
	if (!row.awsRoleArn) return 'awsRoleArn is required';
	if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/.test(row.awsRoleArn)) return 'awsRoleArn does not look like a valid IAM role ARN';
	if (!row.awsRegion) return 'awsRegion is required';
	return null;
}

function fail(error: string): VerifyResult {
	return { ok: false, verifiedAt: null, error };
}
