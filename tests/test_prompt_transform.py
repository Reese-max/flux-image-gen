import re

import pytest

from app.prompt_transform import transform_plain_prompt


CJK_PATTERN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def assert_no_cjk(text: str):
    assert CJK_PATTERN.search(text) is None


def test_transform_cute_shiba_on_moon_ramen_prompt():
    result = transform_plain_prompt("一隻可愛柴犬在月球上吃拉麵，風格要可愛一點")

    assert result.provider == "rule_based"
    assert "Shiba Inu" in result.prompt
    assert "moon" in result.prompt
    assert "ramen" in result.prompt
    assert "adorable" in result.prompt
    assert "highly detailed" in result.prompt
    assert len(result.prompt) <= 900


def test_transform_blank_source_raises_value_error():
    with pytest.raises(ValueError, match="請先輸入白話描述"):
        transform_plain_prompt("   ")


def test_transform_cinematic_taipei_night_market_rain_prompt():
    result = transform_plain_prompt("台北夜市下雨的街景", style="cinematic")

    assert "Taipei night market" in result.prompt
    assert "rainy street scene" in result.prompt
    assert "cinematic lighting" in result.prompt
    assert "film still" in result.prompt


def test_transform_short_prompt_has_warning():
    result = transform_plain_prompt("貓")

    assert "cat" in result.prompt
    assert "描述較短" in result.warnings


def test_transform_common_chinese_fallback_translates_to_english_prompt():
    result = transform_plain_prompt("一個紅色杯子放在木桌上，旁邊有陽光", style="realistic")

    assert_no_cjk(result.prompt)
    assert "red" in result.prompt
    assert "cup" in result.prompt
    assert "wooden table" in result.prompt
    assert "sunlight" in result.prompt


def test_transform_unknown_chinese_fallback_uses_generic_english_with_warning():
    result = transform_plain_prompt("神秘的咕嚕咕嚕魔法場景")

    assert_no_cjk(result.prompt)
    assert any("部分詞彙未能精準翻譯" in warning for warning in result.warnings)
