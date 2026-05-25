import { dataClient } from "$lib/data";
import { requireAuthSession } from "$lib/auth";
import type { Schema } from "../../../amplify/data/resource";

type Client = ReturnType<typeof dataClient>;

export type Pipeline = Schema["Pipeline"]["type"];
export type ModelBranch = Schema["ModelBranch"]["type"];
export type SweepPlan = Schema["SweepPlan"]["type"];
export type TrainingRun = Schema["TrainingRun"]["type"];
export type ComputeJob = Schema["ComputeJob"]["type"];
export type PipelineTemplate =
  | "baseline"
  | "challenger"
  | "ensemble"
  | "custom";
export type BranchStatus =
  | "draft"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "promoted";

export type BuilderGraphSnapshot = {
  readonly version: 1;
  readonly preset: PipelineTemplate;
  readonly providerId: string | null;
  readonly nodes: readonly unknown[];
  readonly edges: readonly unknown[];
};

export type BuilderWorkspace = {
  readonly pipelines: Pipeline[];
  readonly branches: ModelBranch[];
  readonly sweepPlans: SweepPlan[];
  readonly trainingRuns: TrainingRun[];
};

export type SweepCandidate = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
};

export function awsJson(value: unknown): string {
  return JSON.stringify(value);
}

export async function listPipelines(
  client: Client = dataClient(),
): Promise<Pipeline[]> {
  await requireAuthSession();
  const { data } = await client.models.Pipeline.list();
  return (data ?? []) as Pipeline[];
}

export async function listModelBranches(
  client: Client = dataClient(),
): Promise<ModelBranch[]> {
  await requireAuthSession();
  const { data } = await client.models.ModelBranch.list();
  return (data ?? []) as ModelBranch[];
}

export async function listSweepPlans(
  client: Client = dataClient(),
): Promise<SweepPlan[]> {
  await requireAuthSession();
  const { data } = await client.models.SweepPlan.list();
  return (data ?? []) as SweepPlan[];
}

export async function listTrainingRuns(
  client: Client = dataClient(),
): Promise<TrainingRun[]> {
  await requireAuthSession();
  const { data } = await client.models.TrainingRun.list();
  return (data ?? []) as TrainingRun[];
}

export function graphSnapshot(
  preset: PipelineTemplate,
  nodes: readonly unknown[],
  edges: readonly unknown[],
  providerId: string | null = null,
): BuilderGraphSnapshot {
  return { version: 1, preset, providerId, nodes, edges };
}

export function parseSweepValues(raw: string, maxRuns: number): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, Math.max(0, maxRuns));
}

export function sweepCandidates(args: {
  readonly templateName: string;
  readonly parameter: string;
  readonly values: readonly string[];
}): SweepCandidate[] {
  return args.values.map((value, index) => ({
    id: `${args.parameter}-${index + 1}`,
    name: `${args.templateName} ${args.parameter}=${value}`,
    value,
  }));
}

export async function loadBuilderWorkspace(
  client: Client = dataClient(),
): Promise<BuilderWorkspace> {
  const [pipelines, branches, sweepPlans, trainingRuns] = await Promise.all([
    listPipelines(client),
    listModelBranches(client),
    listSweepPlans(client),
    listTrainingRuns(client),
  ]);

  return { pipelines, branches, sweepPlans, trainingRuns };
}

export async function createPipelineWithRootBranch(
  input: {
    readonly name: string;
    readonly description?: string | null;
    readonly template: PipelineTemplate;
    readonly graph: BuilderGraphSnapshot;
    readonly defaultProviderId?: string | null;
  },
  client: Client = dataClient(),
): Promise<{ readonly pipeline: Pipeline; readonly branch: ModelBranch }> {
  await requireAuthSession();
  const { data: pipeline, errors: pipelineErrors } =
    await client.models.Pipeline.create({
      name: input.name,
      description: input.description ?? null,
      status: "draft",
      template: input.template,
      graphJson: awsJson(input.graph),
      defaultProviderId: input.defaultProviderId || null,
    });
  throwGraphQLError(pipelineErrors, "Pipeline.create failed");
  if (!pipeline) throw new Error("Pipeline.create returned no data");

  const { data: branch, errors: branchErrors } =
    await client.models.ModelBranch.create({
      pipelineId: pipeline.id,
      name: `${input.name}-root`,
      changeSummary: "root graph",
      graphJson: awsJson(input.graph),
      status: "draft",
    });
  throwGraphQLError(branchErrors, "ModelBranch.create failed");
  if (!branch) throw new Error("ModelBranch.create returned no data");

  const { errors: updateErrors } = await client.models.Pipeline.update({
    id: pipeline.id,
    activeBranchId: branch.id,
  });
  throwGraphQLError(updateErrors, "Pipeline.update failed");

  return {
    pipeline: { ...pipeline, activeBranchId: branch.id },
    branch,
  };
}

export async function updatePipelineGraph(
  input: {
    readonly pipelineId: string;
    readonly branchId: string;
    readonly template: PipelineTemplate;
    readonly graph: BuilderGraphSnapshot;
  },
  client: Client = dataClient(),
) {
  await requireAuthSession();
  const [pipelineResult, branchResult] = await Promise.all([
    client.models.Pipeline.update({
      id: input.pipelineId,
      template: input.template,
      graphJson: awsJson(input.graph),
      activeBranchId: input.branchId,
    }),
    client.models.ModelBranch.update({
      id: input.branchId,
      graphJson: awsJson(input.graph),
    }),
  ]);
  throwGraphQLError(pipelineResult.errors, "Pipeline.update failed");
  throwGraphQLError(branchResult.errors, "ModelBranch.update failed");
}

export async function createBranchFromCurrent(
  input: {
    readonly pipelineId: string;
    readonly parentBranchId: string;
    readonly parentName: string;
    readonly graph: BuilderGraphSnapshot;
    readonly index: number;
  },
  client: Client = dataClient(),
): Promise<ModelBranch> {
  await requireAuthSession();
  const { data: branch, errors: branchErrors } =
    await client.models.ModelBranch.create({
      pipelineId: input.pipelineId,
      parentBranchId: input.parentBranchId,
      name: `${input.parentName}-branch-${input.index}`,
      changeSummary: "copied graph, ready to edit",
      graphJson: awsJson(input.graph),
      status: "draft",
    });
  throwGraphQLError(branchErrors, "ModelBranch.create failed");
  if (!branch) throw new Error("ModelBranch.create returned no data");

  const { errors: updateErrors } = await client.models.Pipeline.update({
    id: input.pipelineId,
    activeBranchId: branch.id,
  });
  throwGraphQLError(updateErrors, "Pipeline.update failed");
  return branch;
}

export async function queueSweepDrafts(
  input: {
    readonly pipelineId: string;
    readonly branchId: string;
    readonly providerId: string | null;
    readonly template: PipelineTemplate;
    readonly parameter: string;
    readonly values: readonly string[];
    readonly maxSpendUsd: number;
    readonly runConfig?: Record<string, unknown>;
  },
  client: Client = dataClient(),
): Promise<{
  readonly sweepPlan: SweepPlan;
  readonly trainingRuns: TrainingRun[];
  readonly computeJobs: ComputeJob[];
}> {
  await requireAuthSession();
  const { data: sweepPlan, errors: sweepErrors } =
    await client.models.SweepPlan.create({
      pipelineId: input.pipelineId,
      branchId: input.branchId,
      name: `${input.template} ${input.parameter} sweep`,
      parameter: input.parameter,
      valuesJson: awsJson([...input.values]),
      maxRuns: input.values.length,
      maxSpendUsd: input.maxSpendUsd,
      providerId: input.providerId,
      status: "queued",
      generatedRunCount: input.values.length,
    });
  throwGraphQLError(sweepErrors, "SweepPlan.create failed");
  if (!sweepPlan) throw new Error("SweepPlan.create returned no data");

  const queued = await Promise.all(
    input.values.map(async (value) => {
      const { data: run, errors: runErrors } =
        await client.models.TrainingRun.create({
          pipelineId: input.pipelineId,
          branchId: input.branchId,
          providerId: input.providerId,
          modelTemplate: input.template,
          status: "queued",
          configJson: awsJson({
            ...(input.runConfig ?? {}),
            sweepPlanId: sweepPlan.id,
            parameter: input.parameter,
            value,
            [input.parameter]: value,
          }),
          costUsd: input.maxSpendUsd,
        });
      throwGraphQLError(runErrors, "TrainingRun.create failed");
      if (!run) throw new Error("TrainingRun.create returned no data");
      const { data: computeJob, errors: jobErrors } =
        await client.models.ComputeJob.create({
          providerId: input.providerId,
          runId: run.id,
          name: `${input.template} ${input.parameter}=${value}`,
          status: "planned",
          estimatedCostUsd: input.maxSpendUsd,
        });
      throwGraphQLError(jobErrors, "ComputeJob.create failed");
      if (!computeJob) throw new Error("ComputeJob.create returned no data");
      return { run: run as TrainingRun, computeJob: computeJob as ComputeJob };
    }),
  );

  return {
    sweepPlan,
    trainingRuns: queued.map((item) => item.run),
    computeJobs: queued.map((item) => item.computeJob),
  };
}

function throwGraphQLError(
  errors: readonly { message?: string }[] | undefined,
  fallback: string,
): void {
  if (!errors?.length) return;
  throw new Error(
    errors
      .map((error) => error.message)
      .filter(Boolean)
      .join("; ") || fallback,
  );
}
