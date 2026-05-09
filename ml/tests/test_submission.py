"""Tests for submission generation and validation."""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from training.submission import generate_submission, validate_submission


class TestGenerateSubmission:
    def test_creates_csv(self, synthetic_data, tmp_path):
        preds = pd.Series(
            np.random.rand(len(synthetic_data)),
            index=synthetic_data.index,
            name="prediction",
        )
        csv_path = generate_submission(preds, tmp_path, round_num=42)
        assert csv_path.exists()
        assert "r42" in csv_path.name

    def test_predictions_ranked_0_to_1(self, synthetic_data, tmp_path):
        preds = pd.Series(
            np.random.rand(len(synthetic_data)) * 100 - 50,
            index=synthetic_data.index,
            name="prediction",
        )
        csv_path = generate_submission(preds, tmp_path)
        df = pd.read_csv(csv_path)
        assert df["prediction"].min() > 0
        assert df["prediction"].max() <= 1.0

    def test_has_id_and_prediction_columns(self, synthetic_data, tmp_path):
        preds = pd.Series(
            np.random.rand(len(synthetic_data)),
            index=synthetic_data.index,
        )
        csv_path = generate_submission(preds, tmp_path)
        df = pd.read_csv(csv_path)
        assert "id" in df.columns
        assert "prediction" in df.columns
        assert len(df) == len(synthetic_data)

    def test_no_round_num(self, synthetic_data, tmp_path):
        preds = pd.Series(
            np.random.rand(len(synthetic_data)),
            index=synthetic_data.index,
        )
        csv_path = generate_submission(preds, tmp_path)
        assert "submission.csv" == csv_path.name


class TestValidateSubmission:
    def test_valid_submission(self, synthetic_data, tmp_path):
        preds = pd.Series(
            np.random.rand(len(synthetic_data)),
            index=synthetic_data.index,
        )
        csv_path = generate_submission(preds, tmp_path)
        assert validate_submission(csv_path, expected_ids=synthetic_data.index)

    def test_catches_nan(self, tmp_path):
        df = pd.DataFrame({
            "id": ["a", "b", "c"],
            "prediction": [0.5, float("nan"), 0.3],
        })
        csv_path = tmp_path / "bad.csv"
        df.to_csv(csv_path, index=False)
        with pytest.raises(ValueError, match="NaN"):
            validate_submission(csv_path)

    def test_catches_missing_columns(self, tmp_path):
        df = pd.DataFrame({"id": ["a", "b"], "score": [0.1, 0.2]})
        csv_path = tmp_path / "bad.csv"
        df.to_csv(csv_path, index=False)
        with pytest.raises(ValueError, match="Missing columns"):
            validate_submission(csv_path)

    def test_catches_out_of_range(self, tmp_path):
        df = pd.DataFrame({
            "id": ["a", "b"],
            "prediction": [0.5, 1.5],
        })
        csv_path = tmp_path / "bad.csv"
        df.to_csv(csv_path, index=False)
        with pytest.raises(ValueError, match="out of.*range"):
            validate_submission(csv_path)

    def test_catches_missing_ids(self, tmp_path):
        df = pd.DataFrame({
            "id": ["a"],
            "prediction": [0.5],
        })
        csv_path = tmp_path / "bad.csv"
        df.to_csv(csv_path, index=False)
        expected = pd.Index(["a", "b", "c"])
        with pytest.raises(ValueError, match="Missing.*IDs"):
            validate_submission(csv_path, expected_ids=expected)
