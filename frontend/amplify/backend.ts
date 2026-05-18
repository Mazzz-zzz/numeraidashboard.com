import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { verifyNumeraiAccount } from './functions/verify-numerai-account/resource';
import { verifyComputeProvider } from './functions/verify-compute-provider/resource';

defineBackend({
	auth,
	data,
	verifyNumeraiAccount,
	verifyComputeProvider,
});
