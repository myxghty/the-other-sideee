"""
Creates SYNTHETIC sample documents in samples/ for demos and tests:
  samples/opd-05nov.pdf   PDF with a text layer   (needs reportlab)
  samples/opd-05nov.png   image, read with OCR    (needs Pillow)
  samples/opd-05nov.txt   plain text
Run:  python scripts/make_samples.py
"""
from pathlib import Path

LINES = [
    "Lakeside Clinic - OPD prescription",
    "05 Nov 2026 - Dr. N. Varma",
    "Pt: Arun Kumar - 58 M - MRN SYN-20481 (SYNTHETIC)",
    "Rx",
    "1) Tab Metformin 1000mg 1-0-1 A/F",
    "2) Tab Amlodipine 5mg 0-0-1",
    "3) Tab Atorvastatin 20mg 0-0-1",
    "4) Cap Vitamin D3 60000 IU once weekly x 8 weeks",
    "5) Tab Telma 40mg OD morning",
    "Review after 1 month",
]

OUT = Path(__file__).resolve().parents[1] / "samples"


def main():
    OUT.mkdir(exist_ok=True)
    (OUT / "opd-05nov.txt").write_text("\n".join(LINES) + "\n", encoding="utf-8")

    try:
        from reportlab.lib.pagesizes import A5
        from reportlab.pdfgen import canvas

        c = canvas.Canvas(str(OUT / "opd-05nov.pdf"), pagesize=A5)
        y = A5[1] - 50
        for i, line in enumerate(LINES):
            c.setFont("Helvetica-Bold" if i == 0 else "Helvetica", 12 if i == 0 else 10.5)
            c.drawString(36, y, line)
            y -= 26
        c.save()
    except ImportError:
        print("reportlab not installed: skipped PDF")

    try:
        from PIL import Image, ImageDraw, ImageFont

        img = Image.new("RGB", (1400, 760), "white")
        d = ImageDraw.Draw(img)
        try:
            font = ImageFont.truetype("DejaVuSans.ttf", 34)
        except OSError:
            font = ImageFont.load_default()
        for i, line in enumerate(LINES):
            d.text((60, 40 + i * 68), line, fill=(20, 20, 30), font=font)
        img.save(OUT / "opd-05nov.png")
    except ImportError:
        print("Pillow not installed: skipped PNG")
    print(f"Samples written to {OUT}")


if __name__ == "__main__":
    main()
