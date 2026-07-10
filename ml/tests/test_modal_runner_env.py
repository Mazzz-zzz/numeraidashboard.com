from __future__ import annotations

import importlib
import os
import sys
import types

import pytest


class _FakeApp:
    def __init__(self, *_args, **_kwargs):
        pass

    def function(self, *_args, **_kwargs):
        def decorator(fn):
            fn.spawn = lambda **_kwargs: types.SimpleNamespace(object_id="fake-call")
            return fn

        return decorator


class _FakeImage:
    @classmethod
    def debian_slim(cls, *_args, **_kwargs):
        return cls()

    def pip_install(self, *_args, **_kwargs):
        return self


class _FakeSecret:
    @classmethod
    def from_name(cls, *_args, **_kwargs):
        return cls()


def _install_fake_modal(monkeypatch):
    fake_modal = types.SimpleNamespace(
        App=_FakeApp,
        Image=_FakeImage,
        Secret=_FakeSecret,
        fastapi_endpoint=lambda *_args, **_kwargs: lambda fn: fn,
        exception=types.SimpleNamespace(OutputExpiredError=RuntimeError),
        Function=types.SimpleNamespace(from_name=lambda *_args, **_kwargs: None),
        FunctionCall=types.SimpleNamespace(from_id=lambda *_args, **_kwargs: None),
    )
    monkeypatch.setitem(sys.modules, "modal", fake_modal)


@pytest.fixture
def modal_runner(monkeypatch):
    for name in ("ML_S3_BUCKET", "ML_ARTIFACT_BUCKET", "MODAL_APP_NAME"):
        monkeypatch.delenv(name, raising=False)
    _install_fake_modal(monkeypatch)
    sys.modules.pop("sagemaker.modal_runner", None)
    return importlib.import_module("sagemaker.modal_runner")


def test_apply_hyperparam_env_clears_warm_container_values(monkeypatch, modal_runner):
    monkeypatch.setenv("ML_TARGET_COLS", "bad-string")
    monkeypatch.setenv("ML_DEFAULT_NUM_ROUNDS", "999")

    modal_runner._apply_hyperparam_env({"target_cols": ["target_ender_20"]})

    assert "ML_DEFAULT_NUM_ROUNDS" not in os.environ
    assert os.environ["ML_TARGET_COLS"] == '["target_ender_20"]'


def test_validate_hyperparams_rejects_plain_string_target_cols(modal_runner):
    with pytest.raises(ValueError, match="target_cols must be a JSON array"):
        modal_runner._validate_hyperparams({"target_cols": "target_ender_20"})


def test_validate_hyperparams_allows_target_cols_arrays(modal_runner):
    assert modal_runner._validate_hyperparams({"target_cols": ["target_ender_20"]}) == {
        "target_cols": ["target_ender_20"]
    }


def test_modal_app_uses_generic_default_name(modal_runner):
    assert modal_runner.MODAL_APP_NAME == "numerai-dashboard-ml"


def test_resolve_s3_bucket_prefers_explicit_value(monkeypatch, modal_runner):
    monkeypatch.setenv("ML_S3_BUCKET", "environment-bucket")
    assert modal_runner._resolve_s3_bucket("request-bucket") == "request-bucket"


def test_resolve_s3_bucket_reads_environment(monkeypatch, modal_runner):
    monkeypatch.setenv("ML_S3_BUCKET", "environment-bucket")
    assert modal_runner._resolve_s3_bucket() == "environment-bucket"


def test_resolve_s3_bucket_requires_configuration(modal_runner):
    with pytest.raises(ValueError, match="s3_bucket is required"):
        modal_runner._resolve_s3_bucket()
