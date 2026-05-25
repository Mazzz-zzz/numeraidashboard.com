type PreSignUpEvent = {
	readonly request?: {
		readonly clientMetadata?: Record<string, string> | null;
		readonly userAttributes?: Record<string, string> | null;
	};
	response: {
		autoConfirmUser?: boolean;
		autoVerifyEmail?: boolean;
	};
};

export const handler = async (event: PreSignUpEvent): Promise<PreSignUpEvent> => {
	if (!devAutoConfirmEnabled(event)) return event;

	event.response.autoConfirmUser = true;
	if (event.request?.userAttributes?.email) {
		event.response.autoVerifyEmail = true;
	}
	return event;
};

function devAutoConfirmEnabled(event: PreSignUpEvent): boolean {
	return (
		process.env.DEV_AUTO_CONFIRM_SIGNUP === 'true' &&
		event.request?.clientMetadata?.devAutoConfirmSignUp === 'true'
	);
}
