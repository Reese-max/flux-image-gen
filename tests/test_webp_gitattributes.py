"""Minimal test to verify .gitattributes WebP binary fix."""

def test_webp_gitattributes():
    """Verify that WebP files are marked as binary in .gitattributes."""
    with open(".gitattributes", "r") as f:
        content = f.read()
    assert "*.webp binary" in content, (
        "WebP files are not marked as binary in .gitattributes. "
        "Add '*.webp binary' to prevent line ending conversion during clone."
    )