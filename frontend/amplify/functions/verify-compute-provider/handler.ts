import type { Schema } from '../../data/resource';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { requireCallerSub, secretPath, secureProviderRuntimeArgs } from '../workflow-security';

type Args = Schema['verifyComputeProvider']['args'];
type Result = {
	ok: boolean;
	verifiedAt: string | null;
	error: string | null;
	secretRef: string | null;
	apiKeyRef: string | null;
	apiSecretRef: string | null;
};

const ssm = new SSMClient({});

export const handler: Schema['verifyComputeProvider']['functionHandler'] = async (event) => {
	const owner = requireCallerSub(event);
	const secured = secureProviderRuntimeArgs(event.arguments, owner);
	const args = { ...event.arguments, ...secured };
	const material = await resolveProviderSecrets(args, owner);
	const verifiedArgs = { ...args, apiKey: material.apiKey, apiSecret: material.apiSecret };
	const err = await verifyByType(verifiedArgs);
	if (err) {
		return {
			ok: false,
			verifiedAt: null,
			error: err,
			secretRef: null,
			apiKeyRef: material.apiKeyRef,
			apiSecretRef: material.apiSecretRef,
		};
	}
	return {
		ok: true,
		verifiedAt: new Date().toISOString(),
		error: null,
		secretRef: null,
		apiKeyRef: material.apiKeyRef,
		apiSecretRef: material.apiSecretRef,
	};
};

async function resolveProviderSecrets(a: Args, owner: string) {
	const fingerprint = `${a.providerType}:${a.workspaceId ?? ''}:${a.baseUrl ?? ''}:${a.awsRoleArn ?? ''}`;
	const apiKeyRef = a.apiKeyRef ?? (a.apiKey ? secretPath(owner, 'provider', fingerprint, 'api-key') : null);
	const apiSecretRef =
		a.apiSecretRef ?? (a.apiSecret ? secretPath(owner, 'provider', fingerprint, 'api-secret') : null);

	if (a.apiKey && apiKeyRef) await putSecret(apiKeyRef, a.apiKey);
	if (a.apiSecret && apiSecretRef) await putSecret(apiSecretRef, a.apiSecret);

	return {
		apiKey: a.apiKey ?? (apiKeyRef ? await getSecret(apiKeyRef) : null),
		apiSecret: a.apiSecret ?? (apiSecretRef ? await getSecret(apiSecretRef) : null),
		apiKeyRef,
		apiSecretRef,
	};
}

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
		const resp = await fetch(`${base}/api/v1/pods/?offset=0&limit=1`, {
			headers: { Authorization: `Bearer ${a.apiKey}` },
		});
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

async function putSecret(name: string, value: string): Promise<void> {
	await ssm.send(
		new PutParameterCommand({
			Name: name,
			Value: value,
			Type: 'SecureString',
			Overwrite: true,
		})
	);
}

async function getSecret(name: string): Promise<string> {
	const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
	if (!result.Parameter?.Value) throw new Error(`Secret reference not found: ${name}`);
	return result.Parameter.Value;
}
