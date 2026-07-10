import type { ComputeJob } from './compute-service';

type TrainingStatus = NonNullable<ComputeJob['status']>;

export type TrainingLogLine = {
	readonly timestamp: string | null;
	readonly level: string | null;
	readonly message: string;
};

export type TrainingProgress = {
	readonly percent: number;
	readonly label: string;
	readonly etaLabel: string;
	readonly source: 'provider' | 'logs' | 'elapsed' | 'status';
	readonly logLines: readonly TrainingLogLine[];
};

const DEFAULT_TRAINING_MS = 90 * 60 * 1000;
const MAX_RUNNING_ESTIMATE = 95;

export function trainingProgressForJob(
	job: Pick<ComputeJob, 'status' | 'startedAt' | 'finishedAt' | 'logTail' | 'providerJobId'> | null | undefined,
	now: Date = new Date()
): TrainingProgress {
	const status = job?.status ?? 'planned';
	const logLines = parseTrainingLogLines(job?.logTail ?? null);
	const explicitPercent = explicitProgressPercent(job?.logTail ?? null, logLines);

	if (isTerminal(status)) {
		return {
			percent: status === 'completed' ? 100 : clampPercent(explicitPercent ?? 100),
			label: statusLabel(status),
			etaLabel: terminalEtaLabel(status, job?.finishedAt ?? null),
			source: explicitPercent == null ? 'status' : 'provider',
			logLines
		};
	}

	if (explicitPercent != null) {
		return {
			percent: clampPercent(explicitPercent),
			label: progressStepLabel(job?.logTail ?? null, logLines) ?? statusLabel(status),
			etaLabel: estimatedEtaFromPercent(job?.startedAt ?? null, explicitPercent, now),
			source: 'provider',
			logLines
		};
	}

	const startedAt = parseDate(job?.startedAt ?? null);
	if (status === 'running' && startedAt) {
		const elapsedMs = Math.max(0, now.getTime() - startedAt.getTime());
		const percent = Math.min(MAX_RUNNING_ESTIMATE, 10 + (elapsedMs / DEFAULT_TRAINING_MS) * 85);
		return {
			percent: Math.round(percent),
			label: progressStepLabel(job?.logTail ?? null, logLines) ?? 'Training',
			etaLabel: formatDuration(Math.max(0, DEFAULT_TRAINING_MS - elapsedMs)),
			source: 'elapsed',
			logLines
		};
	}

	const queuedPercent = job?.providerJobId ? 5 : 0;
	return {
		percent: queuedPercent,
		label: statusLabel(status),
		etaLabel: status === 'running' ? 'estimating' : 'waiting to start',
		source: 'status',
		logLines
	};
}

export function parseTrainingLogLines(logTail: string | null | undefined, maxLines = 8): TrainingLogLine[] {
	const raw = logTail?.trim();
	if (!raw) return [];
	const fromJson = parseStructuredLogs(raw);
	const lines = fromJson.length ? fromJson : raw.split(/\r?\n/).map((message) => ({ timestamp: null, level: null, message }));
	return lines
		.map((line) => ({ ...line, message: line.message.trim() }))
		.filter((line) => line.message.length > 0)
		.slice(-maxLines);
}

function parseStructuredLogs(raw: string): TrainingLogLine[] {
	const parsed = parseJson(raw);
	const record = asRecord(parsed);
	if (!record) return [];

	const logs = Array.isArray(record.logs) ? record.logs : Array.isArray(record.logTail) ? record.logTail : null;
	if (logs) {
		return logs
			.map((item) => {
				if (typeof item === 'string') return { timestamp: null, level: null, message: item };
				const row = asRecord(item);
				if (!row) return null;
				const message = stringValue(row.log) ?? stringValue(row.message) ?? stringValue(row.text);
				if (!message) return null;
				return {
					timestamp: stringValue(row.timestamp) ?? stringValue(row.time),
					level: stringValue(row.level),
					message
				};
			})
			.filter((item): item is TrainingLogLine => item !== null);
	}

	const message = stringValue(record.logTail) ?? stringValue(record.logs) ?? stringValue(record.message);
	return message ? message.split(/\r?\n/).map((line) => ({ timestamp: null, level: null, message: line })) : [];
}

function explicitProgressPercent(raw: string | null, logLines: readonly TrainingLogLine[]): number | null {
	const fromJson = progressFromJson(parseJson(raw ?? ''));
	if (fromJson != null) return fromJson;

	const text = [raw ?? '', ...logLines.map((line) => line.message)].join('\n');
	const pctMatch = /(?:progress[_\s-]*pct|progress|percent|percentage)[^\d]{0,12}(\d{1,3}(?:\.\d+)?)/i.exec(text);
	if (pctMatch) return clampPercent(Number(pctMatch[1]));

	const ratioMatch = /\b(?:epoch|round|iteration|iter|step)\s+(\d{1,5})\s*\/\s*(\d{1,5})\b/i.exec(text);
	if (ratioMatch) {
		const current = Number(ratioMatch[1]);
		const total = Number(ratioMatch[2]);
		if (total > 0) return clampPercent((current / total) * 100);
	}

	if (/training complete|NUMERAI_DASHBOARD_TRAINING_COMPLETED/i.test(text)) return 100;
	if (/training failed|NUMERAI_DASHBOARD_TRAINING_FAILED/i.test(text)) return 100;
	if (/Starting Modal training|Step 5: Training/i.test(text)) return 20;
	if (/feature_engineering|Step 4: Feature engineering/i.test(text)) return 15;
	if (/loading_(metadata|data)|Step [23]: Loading/i.test(text)) return 10;
	if (/downloading|Downloading source|Downloading Numerai/i.test(text)) return 5;
	if (/pod is ready|Starting Jupyter|CUDA/i.test(text)) return 3;

	return null;
}

function progressFromJson(value: unknown): number | null {
	if (Array.isArray(value)) {
		return value.reduce<number | null>((latest, item) => progressFromJson(item) ?? latest, null);
	}
	const record = asRecord(value);
	if (!record) return null;
	const direct = numberValue(record.progress_pct) ?? numberValue(record.progressPct) ?? numberValue(record.percent) ?? numberValue(record.percentage);
	if (direct != null) return clampPercent(direct);
	return Object.values(record).reduce<number | null>((latest, item) => progressFromJson(item) ?? latest, null);
}

function progressStepLabel(raw: string | null, logLines: readonly TrainingLogLine[]): string | null {
	const parsed = asRecord(parseJson(raw ?? ''));
	const progress = asRecord(parsed?.progress) ?? parsed;
	const step = stringValue(progress?.step);
	if (step) return humanizeStep(step);
	const latest = logLines.at(-1)?.message;
	if (!latest) return null;
	if (/CUDA|pod is ready|Jupyter/i.test(latest)) return 'Preparing GPU';
	if (/Downloading/i.test(latest)) return 'Downloading data';
	if (/Feature engineering/i.test(latest)) return 'Feature engineering';
	if (/Training/i.test(latest)) return 'Training';
	return null;
}

function estimatedEtaFromPercent(startedAt: string | null, percent: number, now: Date): string {
	const started = parseDate(startedAt);
	if (!started || percent <= 0 || percent >= 100) return percent >= 100 ? 'complete' : 'estimating';
	const elapsedMs = Math.max(0, now.getTime() - started.getTime());
	const remainingMs = elapsedMs * ((100 - percent) / percent);
	return formatDuration(remainingMs);
}

function statusLabel(status: string): string {
	switch (status) {
		case 'planned':
			return 'Planned';
		case 'queued':
			return 'Queued';
		case 'running':
			return 'Training';
		case 'completed':
			return 'Completed';
		case 'failed':
			return 'Failed';
		case 'cancelled':
			return 'Cancelled';
		default:
			return 'Training';
	}
}

function terminalEtaLabel(status: TrainingStatus, finishedAt: string | null): string {
	const finished = finishedAt ? ` at ${new Date(finishedAt).toLocaleTimeString()}` : '';
	if (status === 'completed') return `complete${finished}`;
	if (status === 'failed') return `failed${finished}`;
	return `cancelled${finished}`;
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return 'under 1m';
	const minutes = Math.max(1, Math.round(ms / 60000));
	if (minutes < 60) return `~${minutes}m left`;
	const hours = Math.floor(minutes / 60);
	const rem = minutes % 60;
	return rem ? `~${hours}h ${rem}m left` : `~${hours}h left`;
}

function humanizeStep(value: string): string {
	return value
		.replace(/[_-]+/g, ' ')
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function isTerminal(status: string): status is 'completed' | 'failed' | 'cancelled' {
	return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function parseDate(value: string | null): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function parseJson(value: string): unknown {
	if (!value.trim()) return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && Number.isFinite(Number(value))) return Number(value);
	return null;
}
