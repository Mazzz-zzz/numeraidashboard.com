"""ML / Numerai experiment tracking & model registry endpoints."""

import json
import logging
import re
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models import (
    LocalRun,
    MlEnsemble,
    MlEpochMetric,
    MlExperiment,
    MlModel,
    MlRound,
    MlRun,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Pydantic schemas ─────────────────────────────────────────────────


class ExperimentOut(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    status: str
    created_at: str
    run_count: int = 0
    best_corr: Optional[float] = None

    class Config:
        from_attributes = True


class RunOut(BaseModel):
    id: int
    experiment_id: int
    model_type: str
    status: str
    hyperparams_json: Optional[str] = None
    correlation: Optional[float] = None
    sharpe: Optional[float] = None
    feature_exposure: Optional[float] = None
    max_drawdown: Optional[float] = None
    mmc: Optional[float] = None
    progress_pct: Optional[float] = None
    current_epoch: Optional[int] = None
    total_epochs: Optional[int] = None
    instance_type: Optional[str] = None
    cost_usd: Optional[float] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    created_at: str

    class Config:
        from_attributes = True


class EpochMetricOut(BaseModel):
    epoch: int
    train_loss: Optional[float] = None
    val_loss: Optional[float] = None
    correlation: Optional[float] = None
    sharpe: Optional[float] = None

    class Config:
        from_attributes = True


class ModelOut(BaseModel):
    id: int
    name: str
    model_type: str
    stage: str
    version: int
    run_id: Optional[int] = None
    correlation: Optional[float] = None
    sharpe: Optional[float] = None
    feature_exposure: Optional[float] = None
    max_drawdown: Optional[float] = None
    mmc: Optional[float] = None
    numerai_model_id: Optional[str] = None
    s3_artifact_path: Optional[str] = None
    webhook_active: bool = False
    last_submission_round: Optional[int] = None
    last_submission_at: Optional[str] = None
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


class ModelCreate(BaseModel):
    name: str
    model_type: str
    run_id: Optional[int] = None
    correlation: Optional[float] = None
    sharpe: Optional[float] = None


class ModelPatch(BaseModel):
    stage: Optional[str] = None
    numerai_model_id: Optional[str] = None


class TrainRequest(BaseModel):
    experiment_name: str
    description: Optional[str] = None
    feature_set: str = "medium"
    model_type: str = "lgbm"
    instance_type: str = "ml.m5.xlarge"
    hyperparams: Optional[dict] = None
    upload: bool = False
    # NEW: Model configuration options
    neutralization_pct: float = 50.0  # 0-100


class ExperimentCreate(BaseModel):
    name: str
    description: Optional[str] = None


class RunPatch(BaseModel):
    status: Optional[str] = None
    progress_pct: Optional[float] = None
    current_epoch: Optional[int] = None
    total_epochs: Optional[int] = None
    correlation: Optional[float] = None
    sharpe: Optional[float] = None
    feature_exposure: Optional[float] = None
    max_drawdown: Optional[float] = None
    mmc: Optional[float] = None
    instance_type: Optional[str] = None
    cost_usd: Optional[float] = None
    error_message: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None


class EpochMetricIn(BaseModel):
    epoch: int
    train_loss: Optional[float] = None
    val_loss: Optional[float] = None
    correlation: Optional[float] = None
    sharpe: Optional[float] = None


class MetricsBatch(BaseModel):
    metrics: List[EpochMetricIn]


class RoundOut(BaseModel):
    id: int
    round_number: int
    model_name: str
    live_corr: Optional[float] = None
    resolved_corr: Optional[float] = None
    payout_nmr: Optional[float] = None
    status: str
    submitted_at: Optional[str] = None
    created_at: str
    sagemaker_job_name: Optional[str] = None

    class Config:
        from_attributes = True


class EnsembleOut(BaseModel):
    id: int
    method: str
    config_json: Optional[str] = None
    correlation: Optional[float] = None
    sharpe: Optional[float] = None
    is_active: bool
    created_at: str

    class Config:
        from_attributes = True


class LocalRunOut(BaseModel):
    id: int
    sweep: str
    name: str
    family: str
    model_type: str
    status: str
    target: Optional[str] = None
    elapsed_seconds: Optional[float] = None
    neut_pct: float
    correlation: Optional[float] = None
    sharpe: Optional[float] = None
    mmc: Optional[float] = None
    feature_exposure: Optional[float] = None
    max_drawdown: Optional[float] = None
    hyperparams: Optional[dict] = None
    sweep_dir: Optional[str] = None
    source: Optional[str] = None
    inserted_at: Optional[str] = None

    class Config:
        from_attributes = True


# ── Helpers ──────────────────────────────────────────────────────────


def _ts(dt) -> str:
    if dt is None:
        return ""
    return dt.isoformat() if hasattr(dt, "isoformat") else str(dt)


def _fl(v) -> Optional[float]:
    return float(v) if v is not None else None


def _check_poller_key(x_poller_key: Optional[str] = Header(None)):
    """Verify poller API key for internal endpoints."""
    settings = get_settings()
    if not settings.ml_poller_api_key:
        return  # no key configured = allow all (dev mode)
    if x_poller_key != settings.ml_poller_api_key:
        raise HTTPException(status_code=403, detail="Invalid poller key")


def _to_model_out(m) -> ModelOut:
    return ModelOut(
        id=m.id,
        name=m.name,
        model_type=m.model_type,
        stage=m.stage,
        version=m.version,
        run_id=m.run_id,
        correlation=_fl(m.correlation),
        sharpe=_fl(m.sharpe),
        feature_exposure=_fl(m.feature_exposure),
        max_drawdown=_fl(m.max_drawdown),
        mmc=_fl(m.mmc),
        numerai_model_id=m.numerai_model_id,
        s3_artifact_path=m.s3_artifact_path,
        webhook_active=bool(m.webhook_active),
        last_submission_round=m.last_submission_round,
        last_submission_at=_ts(m.last_submission_at),
        created_at=_ts(m.created_at),
        updated_at=_ts(m.updated_at),
    )


# ── Endpoints ────────────────────────────────────────────────────────


@router.get("/ml/overview")
async def ml_overview(
    tournament: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    """Summary: active runs, best model, latest round, ensemble score."""
    run_filter = [MlRun.status.in_(["pending", "running"])]
    if tournament:
        run_filter.append(MlRun.tournament == tournament)
    active_runs = db.query(sa_func.count(MlRun.id)).filter(
        *run_filter
    ).scalar() or 0

    model_q = db.query(MlModel).filter(MlModel.stage == "prod")
    if tournament:
        model_q = model_q.filter(MlModel.tournament == tournament)
    best_model = model_q.order_by(MlModel.correlation.desc().nullslast()).first()

    round_q = db.query(MlRound)
    if tournament:
        round_q = round_q.filter(MlRound.tournament == tournament)
    latest_round = round_q.order_by(MlRound.round_number.desc()).first()

    active_ensemble = (
        db.query(MlEnsemble)
        .filter(MlEnsemble.is_active == True)
        .first()
    )

    # Recent runs
    recent_q = db.query(MlRun)
    if tournament:
        recent_q = recent_q.filter(MlRun.tournament == tournament)
    recent = recent_q.order_by(MlRun.created_at.desc()).limit(10).all()

    return {
        "active_runs": active_runs,
        "best_model": {
            "name": best_model.name,
            "correlation": _fl(best_model.correlation),
            "sharpe": _fl(best_model.sharpe),
            "feature_exposure": _fl(best_model.feature_exposure),
            "max_drawdown": _fl(best_model.max_drawdown),
            "mmc": _fl(best_model.mmc),
        } if best_model else None,
        "latest_round": {
            "round_number": latest_round.round_number,
            "status": latest_round.status,
            "live_corr": _fl(latest_round.live_corr),
        } if latest_round else None,
        "ensemble_score": _fl(active_ensemble.correlation) if active_ensemble else None,
        "total_cost_usd": sum(float(r.cost_usd) for r in recent if r.cost_usd is not None),
        "recent_runs": [
            {
                "id": r.id,
                "model_type": r.model_type,
                "status": r.status,
                "correlation": _fl(r.correlation),
                "sharpe": _fl(r.sharpe),
                "feature_exposure": _fl(r.feature_exposure),
                "max_drawdown": _fl(r.max_drawdown),
                "mmc": _fl(r.mmc),
                "progress_pct": _fl(r.progress_pct),
                "instance_type": r.instance_type,
                "cost_usd": _fl(r.cost_usd),
                "started_at": _ts(r.started_at),
                "finished_at": _ts(r.finished_at),
            }
            for r in recent
        ],
    }


@router.get("/ml/experiments")
async def list_experiments(
    cursor: Optional[int] = None,
    limit: int = Query(default=20, le=100),
    tournament: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    """Cursor-based paginated experiment list."""
    query = db.query(MlExperiment)

    # Filter to experiments that have at least one run in this tournament
    if tournament:
        query = query.filter(
            MlExperiment.id.in_(
                db.query(MlRun.experiment_id).filter(MlRun.tournament == tournament)
            )
        )

    if cursor is not None:
        query = query.filter(MlExperiment.id < cursor)

    query = query.order_by(MlExperiment.id.desc()).limit(limit + 1)
    experiments = query.all()

    has_more = len(experiments) > limit
    experiments = experiments[:limit]

    data = []
    for exp in experiments:
        run_q = [MlRun.experiment_id == exp.id]
        if tournament:
            run_q.append(MlRun.tournament == tournament)
        run_count = db.query(sa_func.count(MlRun.id)).filter(*run_q).scalar() or 0
        best_corr = db.query(sa_func.max(MlRun.correlation)).filter(*run_q).scalar()
        data.append(ExperimentOut(
            id=exp.id,
            name=exp.name,
            description=exp.description,
            status=exp.status,
            created_at=_ts(exp.created_at),
            run_count=run_count,
            best_corr=_fl(best_corr),
        ))

    return {
        "data": data,
        "next_cursor": experiments[-1].id if has_more and experiments else None,
    }


@router.get("/ml/experiments/{experiment_id}/runs")
async def list_runs(experiment_id: int, db: Session = Depends(get_db)):
    """Runs for an experiment, with hyperparams + metrics."""
    exp = db.query(MlExperiment).filter(MlExperiment.id == experiment_id).first()
    if not exp:
        raise HTTPException(status_code=404, detail="Experiment not found")

    runs = (
        db.query(MlRun)
        .filter(MlRun.experiment_id == experiment_id)
        .order_by(MlRun.created_at.desc())
        .all()
    )

    return {
        "data": [
            RunOut(
                id=r.id,
                experiment_id=r.experiment_id,
                model_type=r.model_type,
                status=r.status,
                hyperparams_json=r.hyperparams_json,
                correlation=_fl(r.correlation),
                sharpe=_fl(r.sharpe),
                feature_exposure=_fl(r.feature_exposure),
                max_drawdown=_fl(r.max_drawdown),
                mmc=_fl(r.mmc),
                progress_pct=_fl(r.progress_pct),
                current_epoch=r.current_epoch,
                total_epochs=r.total_epochs,
                instance_type=r.instance_type,
                cost_usd=_fl(r.cost_usd),
                started_at=_ts(r.started_at),
                finished_at=_ts(r.finished_at),
                created_at=_ts(r.created_at),
            )
            for r in runs
        ]
    }


@router.get("/ml/runs/{run_id}/metrics")
async def run_metrics(run_id: int, db: Session = Depends(get_db)):
    """Epoch-level time-series for loss curves."""
    run = db.query(MlRun).filter(MlRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    metrics = (
        db.query(MlEpochMetric)
        .filter(MlEpochMetric.run_id == run_id)
        .order_by(MlEpochMetric.epoch)
        .all()
    )

    return {
        "data": [
            EpochMetricOut(
                epoch=m.epoch,
                train_loss=_fl(m.train_loss),
                val_loss=_fl(m.val_loss),
                correlation=_fl(m.correlation),
                sharpe=_fl(m.sharpe),
            )
            for m in metrics
        ]
    }


@router.get("/ml/models")
async def list_models(
    tournament: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    """Registered models with stage/version."""
    q = db.query(MlModel)
    if tournament:
        q = q.filter(MlModel.tournament == tournament)
    models = q.order_by(MlModel.updated_at.desc()).all()
    return {
        "data": [_to_model_out(m) for m in models]
    }


@router.post("/ml/models")
async def create_model(body: ModelCreate, db: Session = Depends(get_db)):
    """Register a new model (promote from run)."""
    existing = db.query(MlModel).filter(MlModel.name == body.name).first()
    if existing:
        raise HTTPException(status_code=409, detail="Model name already exists")

    if body.run_id:
        run = db.query(MlRun).filter(MlRun.id == body.run_id).first()
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")

    model = MlModel(
        name=body.name,
        model_type=body.model_type,
        run_id=body.run_id,
        correlation=body.correlation,
        sharpe=body.sharpe,
    )
    db.add(model)
    db.commit()
    db.refresh(model)

    return _to_model_out(model)


@router.patch("/ml/models/{model_id}")
async def update_model(model_id: int, body: ModelPatch, db: Session = Depends(get_db)):
    """Update model stage and/or Numerai config."""
    model = db.query(MlModel).filter(MlModel.id == model_id).first()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")

    valid_stages = {"dev", "staging", "prod"}
    if body.stage is not None:
        if body.stage not in valid_stages:
            raise HTTPException(status_code=400, detail=f"Stage must be one of {valid_stages}")
        model.stage = body.stage

    if body.numerai_model_id is not None:
        model.numerai_model_id = body.numerai_model_id or None

    db.commit()
    db.refresh(model)

    return _to_model_out(model)


@router.get("/ml/rounds")
async def list_rounds(
    limit: int = Query(default=50, le=200),
    tournament: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    """Numerai round history."""
    q = db.query(MlRound)
    if tournament:
        q = q.filter(MlRound.tournament == tournament)
    rounds = q.order_by(MlRound.round_number.desc()).limit(limit).all()
    return {
        "data": [
            RoundOut(
                id=r.id,
                round_number=r.round_number,
                model_name=r.model_name,
                live_corr=_fl(r.live_corr),
                resolved_corr=_fl(r.resolved_corr),
                payout_nmr=_fl(r.payout_nmr),
                status=r.status,
                submitted_at=_ts(r.submitted_at),
                created_at=_ts(r.created_at),
                sagemaker_job_name=r.sagemaker_job_name,
            )
            for r in rounds
        ]
    }


@router.get("/ml/ensemble")
async def get_ensemble(db: Session = Depends(get_db)):
    """Current ensemble config + performance."""
    ensemble = (
        db.query(MlEnsemble)
        .filter(MlEnsemble.is_active == True)
        .first()
    )
    if not ensemble:
        return {"data": None}

    return {
        "data": EnsembleOut(
            id=ensemble.id,
            method=ensemble.method,
            config_json=ensemble.config_json,
            correlation=_fl(ensemble.correlation),
            sharpe=_fl(ensemble.sharpe),
            is_active=ensemble.is_active,
            created_at=_ts(ensemble.created_at),
        )
    }


@router.get("/ml/local-runs")
async def get_local_runs(
    sweep: Optional[str] = Query(None, description="Filter by sweep name"),
    family: Optional[str] = Query(None, description="Filter by family (tabm/tabicl)"),
    target: Optional[str] = Query(None, description="Filter by training target (e.g. target_delta_20)"),
    db: Session = Depends(get_db),
):
    """All local sweep snapshots — investigations run on-box (not SageMaker).

    Each row is one (sweep × name × neut_pct) snapshot. TabM checkpoints
    typically contribute four rows per run (one per neutralization level);
    TabICL runs contribute one row at their trained neut level.
    """
    q = db.query(LocalRun)
    if sweep:
        q = q.filter(LocalRun.sweep == sweep)
    if family:
        q = q.filter(LocalRun.family == family)
    if target:
        q = q.filter(LocalRun.target == target)
    rows = q.order_by(LocalRun.sweep, LocalRun.name, LocalRun.neut_pct).all()

    def to_out(r: LocalRun) -> LocalRunOut:
        try:
            hp = json.loads(r.hyperparams_json) if r.hyperparams_json else None
        except Exception:
            hp = None
        return LocalRunOut(
            id=r.id,
            sweep=r.sweep,
            name=r.name,
            family=r.family,
            model_type=r.model_type,
            status=r.status,
            target=r.target,
            elapsed_seconds=_fl(r.elapsed_seconds),
            neut_pct=_fl(r.neut_pct) or 0.0,
            correlation=_fl(r.correlation),
            sharpe=_fl(r.sharpe),
            mmc=_fl(r.mmc),
            feature_exposure=_fl(r.feature_exposure),
            max_drawdown=_fl(r.max_drawdown),
            hyperparams=hp,
            sweep_dir=r.sweep_dir,
            source=r.source,
            inserted_at=_ts(r.inserted_at),
        )

    return {"data": [to_out(r) for r in rows]}


# ── Write endpoints ─────────────────────────────────────────────────


@router.post("/ml/train")
async def trigger_training(body: TrainRequest, db: Session = Depends(get_db)):
    """Create experiment + run and start a training job (SageMaker or Modal)."""
    # Validate inputs
    is_signals = body.feature_set.startswith("signals_")
    valid_feature_sets = {"small", "medium", "all"}
    if not is_signals and body.feature_set not in valid_feature_sets:
        raise HTTPException(status_code=400, detail=f"feature_set must be one of {valid_feature_sets} or signals_*")

    valid_model_types = {"lgbm", "catboost", "mlp", "ft_transformer", "tabm", "modern_nca", "tabpfn", "tabicl"}
    if body.model_type not in valid_model_types:
        raise HTTPException(status_code=400, detail=f"model_type must be one of {valid_model_types}")

    # Determine compute provider
    use_modal = body.instance_type.startswith("modal:")
    use_local = body.instance_type.startswith("local:")

    settings = get_settings()
    if not use_modal and not use_local and (not settings.sagemaker_role_arn or not settings.sagemaker_ecr_image):
        raise HTTPException(status_code=503, detail="SageMaker not configured")

    # Find or create experiment
    exp = db.query(MlExperiment).filter(MlExperiment.name == body.experiment_name).first()
    if not exp:
        exp = MlExperiment(name=body.experiment_name, description=body.description)
        db.add(exp)
        db.flush()

    # Create run — store full config so we can reproduce later
    hyperparams = body.hyperparams or {}
    full_config = {
        "feature_set": body.feature_set,
        "neutralization_pct": body.neutralization_pct,
        "upload": body.upload,
        **hyperparams,
    }
    tournament = "signals" if is_signals else "classic"
    run = MlRun(
        experiment_id=exp.id,
        tournament=tournament,
        model_type=body.model_type,
        status="pending",
        hyperparams_json=json.dumps(full_config),
        instance_type=body.instance_type,
    )
    db.add(run)
    db.flush()

    # Build job name: oo-{experiment}-{run_id}-{timestamp}
    safe_name = re.sub(r"[^a-zA-Z0-9-]", "-", body.experiment_name)[:40]
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    job_name = f"oo-{safe_name}-{run.id}-{ts}"

    try:
        if use_local:
            from app.services.local_service import create_training_job as local_create
            job_arn = local_create(
                job_name=job_name,
                hyperparams=hyperparams,
                instance_type=body.instance_type,
                feature_set=body.feature_set,
                upload=body.upload,
                model_type=body.model_type,
                neutralization_pct=body.neutralization_pct,
            )
        elif use_modal:
            from app.services.modal_service import create_training_job as modal_create
            job_arn = modal_create(
                job_name=job_name,
                hyperparams=hyperparams,
                instance_type=body.instance_type,
                feature_set=body.feature_set,
                upload=body.upload,
                model_type=body.model_type,
                neutralization_pct=body.neutralization_pct,
            )
        else:
            from app.services.sagemaker_service import create_training_job
            job_arn = create_training_job(
                job_name=job_name,
                hyperparams=hyperparams,
                instance_type=body.instance_type,
                feature_set=body.feature_set,
                upload=body.upload,
                model_type=body.model_type,
                neutralization_pct=body.neutralization_pct,
            )
        run.sagemaker_job_name = job_name
        run.sagemaker_job_arn = job_arn
        run.status = "pending"
        db.commit()
    except Exception as e:
        run.status = "failed"
        run.error_message = str(e)[:2000]
        db.commit()
        logger.exception("Failed to create training job")
        raise HTTPException(status_code=500, detail=f"Failed to start training: {e}")

    return {
        "run_id": run.id,
        "experiment_id": exp.id,
        "sagemaker_job_name": job_name,
    }


@router.post("/ml/experiments")
async def create_experiment(body: ExperimentCreate, db: Session = Depends(get_db)):
    """Create a new experiment."""
    existing = db.query(MlExperiment).filter(MlExperiment.name == body.name).first()
    if existing:
        raise HTTPException(status_code=409, detail="Experiment name already exists")

    exp = MlExperiment(name=body.name, description=body.description)
    db.add(exp)
    db.commit()
    db.refresh(exp)

    return ExperimentOut(
        id=exp.id,
        name=exp.name,
        description=exp.description,
        status=exp.status,
        created_at=_ts(exp.created_at),
        run_count=0,
        best_corr=None,
    )


@router.patch("/ml/runs/{run_id}")
async def update_run(
    run_id: int,
    body: RunPatch,
    db: Session = Depends(get_db),
    _auth: None = Depends(_check_poller_key),
):
    """Update run progress/status/metrics (called by poller Lambda)."""
    run = db.query(MlRun).filter(MlRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    valid_statuses = {"pending", "running", "completed", "failed"}

    if body.status is not None:
        if body.status not in valid_statuses:
            raise HTTPException(status_code=400, detail=f"Status must be one of {valid_statuses}")
        run.status = body.status
    if body.progress_pct is not None:
        run.progress_pct = body.progress_pct
    if body.current_epoch is not None:
        run.current_epoch = body.current_epoch
    if body.total_epochs is not None:
        run.total_epochs = body.total_epochs
    if body.correlation is not None:
        run.correlation = body.correlation
    if body.sharpe is not None:
        run.sharpe = body.sharpe
    if body.feature_exposure is not None:
        run.feature_exposure = body.feature_exposure
    if body.max_drawdown is not None:
        run.max_drawdown = body.max_drawdown
    if body.mmc is not None:
        run.mmc = body.mmc
    if body.instance_type is not None:
        run.instance_type = body.instance_type
    if body.cost_usd is not None:
        run.cost_usd = body.cost_usd
    if body.error_message is not None:
        run.error_message = body.error_message[:2000]
    if body.started_at is not None:
        run.started_at = body.started_at
    if body.finished_at is not None:
        run.finished_at = body.finished_at

    db.commit()
    db.refresh(run)

    return RunOut(
        id=run.id,
        experiment_id=run.experiment_id,
        model_type=run.model_type,
        status=run.status,
        hyperparams_json=run.hyperparams_json,
        correlation=_fl(run.correlation),
        sharpe=_fl(run.sharpe),
        feature_exposure=_fl(run.feature_exposure),
        max_drawdown=_fl(run.max_drawdown),
        progress_pct=_fl(run.progress_pct),
        current_epoch=run.current_epoch,
        total_epochs=run.total_epochs,
        instance_type=run.instance_type,
        cost_usd=_fl(run.cost_usd),
        started_at=_ts(run.started_at),
        finished_at=_ts(run.finished_at),
        created_at=_ts(run.created_at),
    )


@router.post("/ml/runs/{run_id}/metrics")
async def batch_insert_metrics(
    run_id: int,
    body: MetricsBatch,
    db: Session = Depends(get_db),
    _auth: None = Depends(_check_poller_key),
):
    """Batch-insert epoch metrics (called by poller Lambda)."""
    run = db.query(MlRun).filter(MlRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    inserted = 0
    for m in body.metrics:
        # Skip if epoch already exists
        existing = db.query(MlEpochMetric).filter(
            MlEpochMetric.run_id == run_id,
            MlEpochMetric.epoch == m.epoch,
        ).first()
        if existing:
            continue

        metric = MlEpochMetric(
            run_id=run_id,
            epoch=m.epoch,
            train_loss=m.train_loss,
            val_loss=m.val_loss,
            correlation=m.correlation,
            sharpe=m.sharpe,
        )
        db.add(metric)
        inserted += 1

    db.commit()
    return {"inserted": inserted}


# ── Numerai production submission endpoints ─────────────────────────


@router.post("/ml/models/{model_id}/submit")
async def submit_model(model_id: int, db: Session = Depends(get_db)):
    """Manually trigger a Numerai submission for a model.

    Starts a lightweight SageMaker inference job that:
    1. Downloads the model artifact from S3
    2. Downloads live Numerai data
    3. Generates predictions
    4. Uploads to Numerai
    """
    from app.services.sagemaker_service import create_inference_job

    model = db.query(MlModel).filter(MlModel.id == model_id).first()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")

    if not model.s3_artifact_path:
        raise HTTPException(status_code=400, detail="Model has no S3 artifact path")

    if not model.numerai_model_id:
        raise HTTPException(status_code=400, detail="Model has no Numerai model ID configured")

    settings = get_settings()
    if not settings.sagemaker_role_arn or not settings.sagemaker_ecr_image:
        raise HTTPException(status_code=503, detail="SageMaker not configured")
    if not settings.numerai_public_id or not settings.numerai_secret_key:
        raise HTTPException(status_code=503, detail="Numerai credentials not configured")

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    job_name = f"oo-infer-{model.id}-{ts}"

    try:
        job_arn = create_inference_job(
            job_name=job_name,
            model_artifact_s3=model.s3_artifact_path,
            tournament=model.tournament,
            model_type=model.model_type,
            numerai_model_id=model.numerai_model_id,
        )
    except Exception as e:
        logger.exception("Failed to create inference job")
        raise HTTPException(status_code=500, detail=f"Failed to start inference: {e}")

    # Create an ml_round entry in "submitting" state
    # Use negative ID as placeholder round_number to avoid unique constraint conflicts
    import random
    placeholder_round = -(random.randint(100000, 999999))
    rnd = MlRound(
        tournament=model.tournament,
        round_number=placeholder_round,
        model_name=model.name,
        status="submitting",
        sagemaker_job_name=job_name,
    )
    db.add(rnd)
    db.commit()
    db.refresh(rnd)

    return {
        "job_name": job_name,
        "job_arn": job_arn,
        "model_id": model.id,
        "round_id": rnd.id,
        "status": "submitting",
    }


@router.post("/ml/models/{model_id}/webhook")
async def register_webhook(model_id: int, db: Session = Depends(get_db)):
    """Register this API's webhook URL with Numerai for automated submissions."""
    model = db.query(MlModel).filter(MlModel.id == model_id).first()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")

    if not model.numerai_model_id:
        raise HTTPException(status_code=400, detail="Set numerai_model_id first")

    settings = get_settings()
    if not settings.numerai_public_id or not settings.numerai_secret_key:
        raise HTTPException(status_code=503, detail="Numerai credentials not configured")

    # Build the webhook URL from our API Gateway
    # This endpoint: POST /api/ml/webhook/numerai?model_id={model_id}
    api_url = f"https://7ia5onp99c.execute-api.ap-southeast-2.amazonaws.com/prod"
    webhook_url = f"{api_url}/api/ml/webhook/numerai?model_id={model_id}"

    try:
        import httpx
        resp = httpx.post(
            "https://api-tournament.numer.ai",
            json={
                "query": """
                    mutation($modelId: String!, $newSubmissionWebhook: String) {
                        setSubmissionWebhook(
                            modelId: $modelId
                            newSubmissionWebhook: $newSubmissionWebhook
                        )
                    }
                """,
                "variables": {
                    "modelId": model.numerai_model_id,
                    "newSubmissionWebhook": webhook_url,
                },
            },
            headers={
                "Authorization": f"Token {settings.numerai_public_id}${settings.numerai_secret_key}",
                "Content-Type": "application/json",
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("errors"):
            raise ValueError(data["errors"][0].get("message", "Unknown error"))
    except Exception as e:
        logger.exception("Failed to register webhook with Numerai")
        raise HTTPException(status_code=500, detail=f"Webhook registration failed: {e}")

    model.webhook_active = True
    db.commit()
    db.refresh(model)

    return {
        "model_id": model.id,
        "webhook_url": webhook_url,
        "webhook_active": True,
    }


@router.delete("/ml/models/{model_id}/webhook")
async def deregister_webhook(model_id: int, db: Session = Depends(get_db)):
    """Deregister the webhook URL from Numerai."""
    model = db.query(MlModel).filter(MlModel.id == model_id).first()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")

    if not model.numerai_model_id:
        raise HTTPException(status_code=400, detail="No numerai_model_id configured")

    settings = get_settings()
    if settings.numerai_public_id and settings.numerai_secret_key:
        try:
            import httpx
            resp = httpx.post(
                "https://api-tournament.numer.ai",
                json={
                    "query": """
                        mutation($modelId: String!) {
                            setSubmissionWebhook(modelId: $modelId, newSubmissionWebhook: null)
                        }
                    """,
                    "variables": {"modelId": model.numerai_model_id},
                },
                headers={
                    "Authorization": f"Token {settings.numerai_public_id}${settings.numerai_secret_key}",
                    "Content-Type": "application/json",
                },
                timeout=30,
            )
            resp.raise_for_status()
        except Exception as e:
            logger.warning("Failed to deregister webhook: %s", e)

    model.webhook_active = False
    db.commit()
    db.refresh(model)

    return {"model_id": model.id, "webhook_active": False}


@router.post("/ml/webhook/numerai")
async def numerai_webhook(
    model_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
):
    """Webhook endpoint called by Numerai when a new round opens.

    Numerai POSTs to this URL. We find the prod model and start inference.
    The model_id query param identifies which model to submit for.
    """
    from app.services.sagemaker_service import create_inference_job

    if model_id is None:
        # If no model_id, find the active prod model
        model = (
            db.query(MlModel)
            .filter(MlModel.stage == "prod", MlModel.webhook_active == True)
            .order_by(MlModel.updated_at.desc())
            .first()
        )
    else:
        model = db.query(MlModel).filter(MlModel.id == model_id).first()

    if not model:
        logger.warning("Webhook received but no eligible model found (model_id=%s)", model_id)
        return {"status": "skipped", "reason": "No eligible model found"}

    if not model.s3_artifact_path or not model.numerai_model_id:
        logger.warning("Webhook: model %d missing artifact or numerai_model_id", model.id)
        return {"status": "skipped", "reason": "Model not fully configured"}

    settings = get_settings()
    if not settings.sagemaker_role_arn or not settings.sagemaker_ecr_image:
        return {"status": "skipped", "reason": "SageMaker not configured"}
    if not settings.numerai_public_id:
        return {"status": "skipped", "reason": "Numerai credentials not set"}

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    job_name = f"oo-infer-{model.id}-{ts}"

    try:
        job_arn = create_inference_job(
            job_name=job_name,
            model_artifact_s3=model.s3_artifact_path,
            tournament=model.tournament,
            model_type=model.model_type,
            numerai_model_id=model.numerai_model_id,
        )
    except Exception as e:
        logger.exception("Webhook: failed to create inference job")
        return {"status": "error", "reason": str(e)}

    # Record the submission attempt
    import random
    placeholder_round = -(random.randint(100000, 999999))
    rnd = MlRound(
        tournament=model.tournament,
        round_number=placeholder_round,
        model_name=model.name,
        status="submitting",
        sagemaker_job_name=job_name,
    )
    db.add(rnd)
    db.commit()

    logger.info("Webhook triggered inference job %s for model %d", job_name, model.id)
    return {
        "status": "triggered",
        "job_name": job_name,
        "model_id": model.id,
    }


@router.post("/ml/runs/{run_id}/cancel")
async def cancel_run(run_id: int, db: Session = Depends(get_db)):
    """Cancel a running training job."""
    run = db.query(MlRun).filter(MlRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    if run.status not in ("pending", "running"):
        raise HTTPException(status_code=400, detail="Run is not active")

    if run.sagemaker_job_name:
        from app.services.sagemaker_service import stop_job
        stop_job(run.sagemaker_job_name)

    run.status = "failed"
    run.error_message = "Cancelled by user"
    run.finished_at = datetime.now(timezone.utc)
    db.commit()

    return {"run_id": run.id, "status": "failed"}
