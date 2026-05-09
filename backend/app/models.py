from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    func,
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


class MlExperiment(Base):
    __tablename__ = "ml_experiments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(120), unique=True, nullable=False)
    description = Column(String(500))
    status = Column(String(20), nullable=False, default="active")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    runs = relationship("MlRun", back_populates="experiment", cascade="all, delete-orphan")


class MlRun(Base):
    __tablename__ = "ml_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    experiment_id = Column(Integer, ForeignKey("ml_experiments.id", ondelete="CASCADE"), nullable=False)
    tournament = Column(String(20), nullable=False, default="classic")
    model_type = Column(String(30), nullable=False)
    status = Column(String(20), nullable=False, default="pending")
    hyperparams_json = Column(String(4000))
    correlation = Column(Numeric(10, 6))
    sharpe = Column(Numeric(10, 6))
    feature_exposure = Column(Numeric(10, 6))
    max_drawdown = Column(Numeric(10, 6))
    mmc = Column(Numeric(10, 6))
    progress_pct = Column(Numeric(5, 2), default=0)
    current_epoch = Column(Integer, default=0)
    total_epochs = Column(Integer, default=0)
    started_at = Column(DateTime(timezone=True))
    finished_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    sagemaker_job_name = Column(String(120))
    sagemaker_job_arn = Column(String(256))
    error_message = Column(String(2000))
    instance_type = Column(String(30))
    cost_usd = Column(Numeric(10, 4))

    experiment = relationship("MlExperiment", back_populates="runs")
    epoch_metrics = relationship("MlEpochMetric", back_populates="run", cascade="all, delete-orphan")

    __table_args__ = (
        Index("ix_ml_runs_experiment_status", "experiment_id", "status"),
        Index("ix_ml_runs_sagemaker_job", "sagemaker_job_name"),
        Index("ix_ml_runs_tournament", "tournament"),
    )


class MlEpochMetric(Base):
    __tablename__ = "ml_epoch_metrics"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(Integer, ForeignKey("ml_runs.id", ondelete="CASCADE"), nullable=False)
    epoch = Column(Integer, nullable=False)
    train_loss = Column(Numeric(10, 6))
    val_loss = Column(Numeric(10, 6))
    correlation = Column(Numeric(10, 6))
    sharpe = Column(Numeric(10, 6))

    run = relationship("MlRun", back_populates="epoch_metrics")

    __table_args__ = (
        Index("ix_ml_epoch_metrics_run_epoch", "run_id", "epoch", unique=True),
    )


class MlModel(Base):
    __tablename__ = "ml_models"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(120), unique=True, nullable=False)
    tournament = Column(String(20), nullable=False, default="classic")
    model_type = Column(String(30), nullable=False)
    stage = Column(String(20), nullable=False, default="dev")
    version = Column(Integer, nullable=False, default=1)
    run_id = Column(Integer, ForeignKey("ml_runs.id", ondelete="SET NULL"))
    correlation = Column(Numeric(10, 6))
    sharpe = Column(Numeric(10, 6))
    feature_exposure = Column(Numeric(10, 6))
    max_drawdown = Column(Numeric(10, 6))
    mmc = Column(Numeric(10, 6))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    numerai_model_id = Column(String(60))
    s3_artifact_path = Column(String(500))
    webhook_active = Column(Boolean, default=False)
    last_submission_round = Column(Integer)
    last_submission_at = Column(DateTime(timezone=True))

    run = relationship("MlRun")

    __table_args__ = (
        Index("ix_ml_models_stage", "stage"),
    )


class MlRound(Base):
    __tablename__ = "ml_rounds"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tournament = Column(String(20), nullable=False, default="classic")
    round_number = Column(Integer, nullable=False)
    model_name = Column(String(120), nullable=False)
    live_corr = Column(Numeric(10, 6))
    resolved_corr = Column(Numeric(10, 6))
    payout_nmr = Column(Numeric(10, 6))
    status = Column(String(20), nullable=False, default="pending")
    submitted_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    sagemaker_job_name = Column(String(120))

    __table_args__ = (
        Index("ix_ml_rounds_round_model", "round_number", "model_name", unique=True),
    )


class MlEnsemble(Base):
    __tablename__ = "ml_ensembles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    method = Column(String(30), nullable=False)
    config_json = Column(String(4000))
    correlation = Column(Numeric(10, 6))
    sharpe = Column(Numeric(10, 6))
    is_active = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_ml_ensembles_active", "is_active"),
    )


class LocalRun(Base):
    __tablename__ = "local_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    sweep = Column(String(60), nullable=False)
    name = Column(String(120), nullable=False)
    family = Column(String(30), nullable=False)
    model_type = Column(String(30), nullable=False)
    status = Column(String(20), nullable=False)
    target = Column(String(60))
    elapsed_seconds = Column(Numeric(12, 2))

    neut_pct = Column(Numeric(5, 2), nullable=False)
    correlation = Column(Numeric(12, 8))
    sharpe = Column(Numeric(12, 6))
    mmc = Column(Numeric(12, 8))
    feature_exposure = Column(Numeric(12, 6))
    max_drawdown = Column(Numeric(12, 6))

    hyperparams_json = Column(String(2000))
    sweep_dir = Column(String(500))
    source = Column(String(60))

    inserted_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_local_runs_unique", "sweep", "name", "neut_pct", unique=True),
        Index("ix_local_runs_family", "family"),
        Index("ix_local_runs_sweep", "sweep"),
    )
