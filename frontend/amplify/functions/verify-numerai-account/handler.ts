import type { Schema } from '../../data/resource';

const NUMERAI_GRAPHQL = 'https://api-tournament.numer.ai/';

export const handler: Schema['verifyNumeraiAccount']['functionHandler'] = async (event) => {
	const { publicId, secretKey } = event.arguments;
	if (!publicId || !secretKey) {
		return { ok: false, verifiedAt: null, error: 'publicId and secretKey are required' };
	}

	try {
		const resp = await fetch(NUMERAI_GRAPHQL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-public-id': publicId,
				'x-secret-key': secretKey,
			},
			body: JSON.stringify({ query: 'query { account { username id } }' }),
		});
		const body = (await resp.json()) as {
			data?: { account?: { id?: string } };
			errors?: { message: string }[];
		};
		if (!resp.ok || body.errors?.length) {
			return { ok: false, verifiedAt: null, error: body.errors?.[0]?.message ?? `HTTP ${resp.status}` };
		}
		if (!body.data?.account?.id) {
			return { ok: false, verifiedAt: null, error: 'Numerai returned no account' };
		}
		return { ok: true, verifiedAt: new Date().toISOString(), error: null };
	} catch (e) {
		return { ok: false, verifiedAt: null, error: e instanceof Error ? e.message : String(e) };
	}
};
