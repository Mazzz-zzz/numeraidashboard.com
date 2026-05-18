import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/verify-numerai-account';

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

const NUMERAI_GRAPHQL = 'https://api-tournament.numer.ai/';

type VerifyResult = { ok: boolean; verifiedAt: string | null; error: string | null };

export const handler: Schema['verifyNumeraiAccount']['functionHandler'] = async (event) => {
	const id = event.arguments.id;
	const owner = event.identity && 'sub' in event.identity ? `${event.identity.sub}::${event.identity.username}` : null;

	const { data: row, errors } = await client.models.NumeraiAccount.get({ id });
	if (errors?.length || !row) {
		return fail('Account not found');
	}
	if (owner && row.owner && row.owner !== owner) {
		return fail('Not authorized');
	}
	if (!row.publicId || !row.secretKey) {
		return fail('Missing publicId or secretKey');
	}

	let verifyError: string | null = null;
	try {
		const resp = await fetch(NUMERAI_GRAPHQL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-public-id': row.publicId,
				'x-secret-key': row.secretKey,
			},
			body: JSON.stringify({
				query: 'query { account { username id } }',
			}),
		});
		const body = (await resp.json()) as { data?: { account?: { id?: string } }; errors?: { message: string }[] };
		if (!resp.ok || body.errors?.length) {
			verifyError = body.errors?.[0]?.message ?? `HTTP ${resp.status}`;
		} else if (!body.data?.account?.id) {
			verifyError = 'Numerai returned no account';
		}
	} catch (e) {
		verifyError = e instanceof Error ? e.message : String(e);
	}

	const now = new Date().toISOString();
	if (verifyError) {
		await client.models.NumeraiAccount.update({ id, verifiedAt: null, lastVerifyError: verifyError });
		return { ok: false, verifiedAt: null, error: verifyError } satisfies VerifyResult;
	}
	await client.models.NumeraiAccount.update({ id, verifiedAt: now, lastVerifyError: null });
	return { ok: true, verifiedAt: now, error: null } satisfies VerifyResult;
};

function fail(error: string): VerifyResult {
	return { ok: false, verifiedAt: null, error };
}
