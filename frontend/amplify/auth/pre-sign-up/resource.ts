import { defineFunction } from '@aws-amplify/backend';

const branch = process.env.AWS_BRANCH ?? process.env.AMPLIFY_BRANCH ?? '';
const devAutoConfirm =
	process.env.DEV_AUTO_CONFIRM_SIGNUP ??
	(branch ? String(!['main', 'production', 'prod'].includes(branch.toLowerCase())) : 'true');

export const preSignUp = defineFunction({
	name: 'pre-sign-up',
	entry: './handler.ts',
	resourceGroupName: 'auth',
	environment: {
		DEV_AUTO_CONFIRM_SIGNUP: devAutoConfirm,
	},
});
