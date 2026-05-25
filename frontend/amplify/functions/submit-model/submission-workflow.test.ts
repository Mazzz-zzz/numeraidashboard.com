import { describe, expect, it } from 'vitest';
import { planSubmission } from './submission-workflow';

const checkedAt = '2026-05-23T16:00:00.000Z';

describe('submit model workflow', () => {
	it('prepares export-only artifacts without a Numerai account', () => {
		const result = planSubmission({
			modelId: 'model-1',
			providerId: 'provider-1',
			numeraiAccountId: null,
			roundNumber: 842,
			predictionSet: 'live',
			neutralizationPct: 50,
			validationMode: 'schema_range_rank',
			uploadEnabled: false,
			checkedAt,
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'planned',
			submissionId: null,
			roundNumber: 842,
			checkedAt,
			error: null,
		});
		expect(result.artifactUri).toMatch(
			/^artifact:\/\/numeraidashboard\/predictions\/model-1\/round-842\/[a-f0-9]{20}\.csv$/
		);
		expect(result.logTail).toContain('Prepared export-only prediction artifact');
	});

	it('queues upload submissions with deterministic external ids and artifacts', () => {
		const first = planSubmission({
			modelId: 'model-1',
			providerId: 'provider-1',
			numeraiAccountId: 'account-1',
			roundNumber: 842,
			predictionSet: 'live',
			neutralizationPct: 50,
			validationMode: 'schema_range_rank',
			uploadEnabled: true,
			checkedAt,
		});
		const second = planSubmission({
			modelId: 'model-1',
			providerId: 'provider-1',
			numeraiAccountId: 'account-1',
			roundNumber: 842,
			predictionSet: 'live',
			neutralizationPct: 50,
			validationMode: 'schema_range_rank',
			uploadEnabled: true,
			checkedAt,
		});

		expect(first.status).toBe('queued');
		expect(first.submissionId).toBe(second.submissionId);
		expect(first.submissionId).toMatch(/^numerai-[a-f0-9]{20}$/);
		expect(first.artifactUri).toBe(second.artifactUri);
		expect(first.logTail).toContain('Queued Numerai upload');
	});

	it('validates upload account, validation mode, neutralization, and round inputs', () => {
		expect(
			planSubmission({
				modelId: 'model-1',
				providerId: 'provider-1',
				numeraiAccountId: null,
				roundNumber: 842,
				predictionSet: 'live',
				neutralizationPct: 50,
				validationMode: 'schema_range_rank',
				uploadEnabled: true,
				checkedAt,
			})
		).toMatchObject({
			ok: false,
			status: 'failed',
			error: 'numeraiAccountId is required when upload is enabled',
		});
		expect(
			planSubmission({
				modelId: 'model-1',
				providerId: 'provider-1',
				numeraiAccountId: 'account-1',
				roundNumber: 0,
				predictionSet: 'live',
				neutralizationPct: 50,
				validationMode: 'schema_range_rank',
				uploadEnabled: false,
				checkedAt,
			}).error
		).toBe('roundNumber must be a positive integer when provided');
		expect(
			planSubmission({
				modelId: 'model-1',
				providerId: 'provider-1',
				numeraiAccountId: 'account-1',
				roundNumber: 842,
				predictionSet: 'live',
				neutralizationPct: 101,
				validationMode: 'schema_range_rank',
				uploadEnabled: false,
				checkedAt,
			}).error
		).toBe('neutralizationPct must be between 0 and 100');
		expect(
			planSubmission({
				modelId: 'model-1',
				providerId: 'provider-1',
				numeraiAccountId: 'account-1',
				roundNumber: 842,
				predictionSet: 'live',
				neutralizationPct: 50,
				validationMode: 'loose',
				uploadEnabled: false,
				checkedAt,
			}).error
		).toContain('Unsupported validationMode "loose"');
	});
});
