"""Generate and validate Numerai submission CSVs."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import pandas as pd


def generate_submission(
    predictions: pd.Series,
    output_path: Path,
    round_num: Optional[int] = None,
) -> Path:
    """Rank predictions to [0, 1] and write submission CSV.

    Args:
        predictions: Series with stock id as index and raw predictions as values.
        output_path: Directory to write the CSV.
        round_num: Optional round number for filename.

    Returns:
        Path to the written CSV file.
    """
    output_path = Path(output_path)
    output_path.mkdir(parents=True, exist_ok=True)

    # Rank-normalize to [0, 1]
    ranked = predictions.rank(pct=True, method="first")

    submission = pd.DataFrame({
        "id": ranked.index,
        "prediction": ranked.values,
    })

    suffix = f"_r{round_num}" if round_num else ""
    csv_path = output_path / f"submission{suffix}.csv"
    submission.to_csv(csv_path, index=False)

    return csv_path


def validate_submission(
    csv_path: Path,
    expected_ids: Optional[pd.Index] = None,
) -> bool:
    """Validate a submission CSV for Numerai format compliance.

    Checks:
    - Has 'id' and 'prediction' columns
    - No NaN values
    - Predictions in [0, 1] range
    - All expected IDs present (if provided)

    Raises ValueError with details on failure.
    """
    df = pd.read_csv(csv_path)

    # Check columns
    required = {"id", "prediction"}
    if not required.issubset(df.columns):
        missing = required - set(df.columns)
        raise ValueError(f"Missing columns: {missing}")

    # Check NaN
    if df["prediction"].isna().any():
        n_nan = df["prediction"].isna().sum()
        raise ValueError(f"Found {n_nan} NaN predictions")

    # Check range
    if df["prediction"].min() < 0 or df["prediction"].max() > 1:
        raise ValueError(
            f"Predictions out of [0,1] range: "
            f"min={df['prediction'].min()}, max={df['prediction'].max()}"
        )

    # Check ID completeness
    if expected_ids is not None:
        submitted_ids = set(df["id"])
        expected_set = set(expected_ids)
        missing_ids = expected_set - submitted_ids
        if missing_ids:
            raise ValueError(
                f"Missing {len(missing_ids)} IDs in submission"
            )

    return True


def upload_submission(
    csv_path: Path,
    public_id: str,
    secret_key: str,
    model_id: str,
) -> str:
    """Upload submission to Numerai via numerapi.

    Requires valid credentials (public_id, secret_key, model_id).
    Returns the submission ID from Numerai.
    """
    import numerapi

    napi = numerapi.NumerAPI(
        public_id=public_id,
        secret_key=secret_key,
    )
    submission_id = napi.upload_predictions(
        str(csv_path),
        model_id=model_id,
    )
    return submission_id
