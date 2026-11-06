"""
Get text lines (with confidence) out of an uploaded file.
  PDF with a text layer -> pypdf (exact text, confidence 0.99)
  Image / scanned PDF   -> Tesseract OCR (per-line confidence from Tesseract)
  Plain text            -> as is
"""
import shutil
import subprocess
import tempfile
from pathlib import Path


class ExtractionError(Exception):
    pass


def _clean(lines):
    return [(t.strip(), c) for t, c in lines if t and t.strip()]


def _pdf_text(path: Path):
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise ExtractionError("pypdf is not installed") from exc
    reader = PdfReader(str(path))
    lines = []
    for page in reader.pages:
        for t in (page.extract_text() or "").splitlines():
            lines.append((t, 0.99))
    return _clean(lines)


def _ocr_image(path: Path):
    try:
        import pytesseract
        from PIL import Image, ImageOps
    except ImportError as exc:
        raise ExtractionError("OCR needs pytesseract and Pillow (pip) plus the tesseract program") from exc
    if not shutil.which("tesseract"):
        raise ExtractionError("The tesseract program is not installed on this server")
    img = ImageOps.grayscale(Image.open(path))
    if img.width < 1500:  # small photos OCR better when enlarged
        scale = 1500 / img.width
        img = img.resize((int(img.width * scale), int(img.height * scale)))
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT, config="--psm 6")
    lines: dict[tuple, list] = {}
    for i, word in enumerate(data["text"]):
        if not word.strip():
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        lines.setdefault(key, []).append((word, float(data["conf"][i])))
    out = []
    for key in sorted(lines):
        words = lines[key]
        confs = [c for _, c in words if c >= 0]
        out.append((" ".join(w for w, _ in words), round((sum(confs) / len(confs) / 100) if confs else 0.5, 2)))
    return _clean(out)


def _scanned_pdf(path: Path):
    if not shutil.which("pdftoppm"):
        raise ExtractionError("This PDF has no text layer and pdftoppm (poppler) is not installed for OCR")
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-r", "200", "-png", str(path), f"{tmp}/p"], check=True, timeout=120)
        lines = []
        for img in sorted(Path(tmp).glob("p*.png")):
            lines += _ocr_image(img)
        return lines


def extract_lines(path: str, content_type: str | None, file_name: str = "") -> tuple[list, str]:
    """Returns ([(text, confidence)], method)."""
    p = Path(path)
    ct = (content_type or "").lower()
    name = file_name.lower()
    if ct == "application/pdf" or name.endswith(".pdf"):
        lines = _pdf_text(p)
        if sum(len(t) for t, _ in lines) >= 20:
            return lines, "pdf-text"
        return _scanned_pdf(p), "ocr"
    if ct.startswith("image/") or name.endswith((".png", ".jpg", ".jpeg")):
        return _ocr_image(p), "ocr"
    if ct.startswith("text/") or name.endswith(".txt"):
        return _clean((t, 0.99) for t in p.read_text(encoding="utf-8", errors="replace").splitlines()), "text"
    raise ExtractionError(f"Unsupported file type {content_type or name}")
