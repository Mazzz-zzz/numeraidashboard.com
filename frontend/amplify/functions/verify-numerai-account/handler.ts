import type { Schema } from '../../data/resource';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createHash } from 'node:crypto';

const NUMERAI_GRAPHQL = 'https://api-tournament.numer.ai/';
const ssm = new SSMClient({});

export const handler: Schema['verifyNumeraiAccount']['functionHandler'] = async (event) => {
	const { publicId, secretKey, secretRef } = event.arguments;
	if (!publicId || (!secretKey && !secretRef)) {
		return {
			ok: false,
			verifiedAt: null,
			error: 'publicId and either secretKey or secretRef are required',
			secretRef: null,
			apiKeyRef: null,
			apiSecretRef: null,
		};
	}

	try {
		const owner = ownerSub(event);
		const nextSecretRef = secretRef ?? secretPath(owner, 'numerai', publicId, 'secret-key');
		if (secretKey) await putSecret(nextSecretRef, secretKey);
		const resolvedSecret = secretKey ?? (await getSecret(nextSecretRef));

		const resp = await fetch(NUMERAI_GRAPHQL, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Token ${publicId}$${resolvedSecret}`,
			},
			body: JSON.stringify({ query: 'query { account { username id } }' }),
		});
		const body = (await resp.json()) as {
			data?: { account?: { id?: string } };
			errors?: { message: string }[];
		};
		if (!resp.ok || body.errors?.length) {
			return {
				ok: false,
				verifiedAt: null,
				error: body.errors?.[0]?.message ?? `HTTP ${resp.status}`,
				secretRef: nextSecretRef,
				apiKeyRef: null,
				apiSecretRef: null,
			};
		}
		if (!body.data?.account?.id) {
			return {
				ok: false,
				verifiedAt: null,
				error: 'Numerai returned no account',
				secretRef: nextSecretRef,
				apiKeyRef: null,
				apiSecretRef: null,
			};
		}
		return {
			ok: true,
			verifiedAt: new Date().toISOString(),
			error: null,
			secretRef: nextSecretRef,
			apiKeyRef: null,
			apiSecretRef: null,
		};
	} catch (e) {
		return {
			ok: false,
			verifiedAt: null,
			error: e instanceof Error ? e.message : String(e),
			secretRef: secretRef ?? null,
			apiKeyRef: null,
			apiSecretRef: null,
		};
	}
};

function ownerSub(event: { identity?: unknown }): string {
	const identity = event.identity as { sub?: string; claims?: { sub?: string } } | undefined;
	return identity?.sub ?? identity?.claims?.sub ?? 'unknown-user';
}

function secretPath(owner: string, scope: string, key: string, name: string): string {
	const digest = createHash('sha256').update(`${scope}:${key}`).digest('hex').slice(0, 24);
	return `/numeraidashboard/${owner}/${scope}/${digest}/${name}`;
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
