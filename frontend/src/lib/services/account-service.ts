import { dataClient } from '$lib/data';
import type { Schema } from '../../../amplify/data/resource';

type Client = ReturnType<typeof dataClient>;

export type NumeraiAccount = Schema['NumeraiAccount']['type'];

export async function listNumeraiAccounts(client: Client = dataClient()): Promise<NumeraiAccount[]> {
	const { data } = await client.models.NumeraiAccount.list();
	return (data ?? []) as NumeraiAccount[];
}
