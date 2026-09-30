"""Issue #9 迴歸：從歷史／結果「再生」路徑必須重用作品儲存的 providerPrompt，
不能直接把中文描述或另一筆狀態當成供應商提示詞送到 /generate。

行為驗證寫在 node:test 前端測試裡（tests/frontend/regenerate-settings.test.cjs），
此測試負責在 pytest 套件內驅動它。"""
import shutil
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HARNESS = REPO_ROOT / "tests" / "frontend" / "regenerate-settings.test.cjs"


def test_history_and_result_regenerate_reuse_stored_provider_prompt():
    node = shutil.which("node")
    assert node, "node 不在 PATH，無法執行前端迴歸測試"
    result = subprocess.run(
        [node, "--test", str(HARNESS)],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(REPO_ROOT),
    )
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
