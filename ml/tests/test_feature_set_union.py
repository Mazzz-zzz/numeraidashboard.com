"""Feature-set union syntax: "a+b" returns the deduplicated ordered union."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from data.download import get_feature_set

META = {"feature_sets": {
    "small": ["f_a", "f_b"],
    "quantum": ["f_q1", "f_a", "f_q2"],
}}


def test_single_set_unchanged():
    assert get_feature_set(META, "small") == ["f_a", "f_b"]


def test_union_dedupes_preserving_order():
    assert get_feature_set(META, "quantum+small") == ["f_q1", "f_a", "f_q2", "f_b"]
    assert get_feature_set(META, "small+quantum") == ["f_a", "f_b", "f_q1", "f_q2"]


def test_unknown_member_raises():
    with pytest.raises(ValueError, match="not found"):
        get_feature_set(META, "quantum+bogus")


def test_empty_name_raises():
    with pytest.raises(ValueError):
        get_feature_set(META, "+")
