import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../amplify/data/resource';

import './auth';

let _client: ReturnType<typeof generateClient<Schema>> | null = null;

export function dataClient() {
	if (!_client) {
		_client = generateClient<Schema>({ authMode: 'userPool' });
	}
	return _client;
}
