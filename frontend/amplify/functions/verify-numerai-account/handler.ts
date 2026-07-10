import type { Schema } from '../../data/resource';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ownedSecretRef, requireCallerSub, secretPath } from '../workflow-security';

const NUMERAI_GRAPHQL = 'https://api-tournament.numer.ai/';
const ssm = new SSMClient({});

export const handler: Schema['verifyNumeraiAccount']['functionHandler'] = async (event) => {
	const { publicId, secretKey, secretRef } = event.arguments;
	const trimmedPublicId = publicId?.trim();
	if (!trimmedPublicId || (!secretKey && !secretRef?.trim())) {
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
		const owner = requireCallerSub(event);
		const nextSecretRef =
			ownedSecretRef(secretKey ? null : secretRef, owner, 'Numerai secret reference') ??
			secretPath(owner, 'numerai', trimmedPublicId, 'secret-key');
		if (secretKey) await putSecret(nextSecretRef, secretKey);
		const resolvedSecret = secretKey ?? (await getSecret(nextSecretRef));

		const resp = await fetch(NUMERAI_GRAPHQL, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Token ${trimmedPublicId}$${resolvedSecret}`,
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
			secretRef: null,
			apiKeyRef: null,
			apiSecretRef: null,
		};
	}
};

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
