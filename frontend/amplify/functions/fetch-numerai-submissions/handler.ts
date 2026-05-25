import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { Schema } from '../../data/resource';
import { fetchNumeraiSubmissions } from './numerai-query';

const ssm = new SSMClient({});

export const handler: Schema['fetchNumeraiSubmissions']['functionHandler'] = async (event) => {
	const checkedAt = new Date().toISOString();
	const { publicId, secretKey, secretRef, numeraiModelIds, maxRounds } = event.arguments;

	const trimmedPublicId = publicId?.trim();
	if (!trimmedPublicId) {
		return errorResult('publicId is required', checkedAt);
	}
	const ids = Array.isArray(numeraiModelIds)
		? numeraiModelIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
		: [];
	if (!ids.length) {
		return errorResult('numeraiModelIds must contain at least one id', checkedAt);
	}

	let resolvedSecret: string | null = null;
	try {
		if (secretKey?.trim()) {
			resolvedSecret = secretKey.trim();
		} else if (secretRef?.trim()) {
			resolvedSecret = await getSecret(secretRef.trim());
		}
	} catch (e) {
		return errorResult(`Failed to resolve Numerai secret: ${e instanceof Error ? e.message : String(e)}`, checkedAt);
	}
	if (!resolvedSecret) {
		return errorResult('Either secretKey or secretRef must be supplied', checkedAt);
	}

	try {
		const models = await fetchNumeraiSubmissions({
			publicId: trimmedPublicId,
			secretKey: resolvedSecret,
			numeraiModelIds: ids,
			maxRounds: typeof maxRounds === 'number' && maxRounds > 0 ? maxRounds : undefined,
		});
		return {
			ok: true,
			checkedAt,
			error: null,
			modelsJson: JSON.stringify(models),
		};
	} catch (e) {
		return errorResult(e instanceof Error ? e.message : String(e), checkedAt);
	}
};

function errorResult(error: string, checkedAt: string) {
	return {
		ok: false,
		checkedAt,
		error,
		modelsJson: JSON.stringify([]),
	};
}

async function getSecret(name: string): Promise<string> {
	const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
	if (!result.Parameter?.Value) throw new Error(`Secret reference not found: ${name}`);
	return result.Parameter.Value;
}
