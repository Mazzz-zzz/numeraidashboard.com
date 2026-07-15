export const trainingFunctionEnvironment = {
	MODAL_APP_HOST: process.env.MODAL_APP_HOST?.trim() ?? '',
	ML_ARTIFACT_BUCKET: process.env.ML_ARTIFACT_BUCKET?.trim() ?? '',
	// The operator-owned public Numerai worker template. Prime users can launch
	// immediately with this template, or override it in advanced provider settings.
	PRIME_DEFAULT_TEMPLATE_ID: process.env.PRIME_DEFAULT_TEMPLATE_ID?.trim() ?? '',
};
