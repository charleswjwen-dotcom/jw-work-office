import os
import re
import sys
import subprocess
import json
from urllib.request import pathname2url

BASE = os.path.dirname(__file__)
SAMPLES = os.path.join(BASE, "samples")
OUT = os.path.join(BASE, "pdf_out")
PROFILE = os.path.join(BASE, "lo_profile")
SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice"

ANCHOR_RE = re.compile(r"\[([PMCN])(\d+)-(\d+)\]")


def convert_to_pdf(docx_path):
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(PROFILE, exist_ok=True)
    profile_uri = "file://" + pathname2url(PROFILE)
    subprocess.run(
        [
            SOFFICE,
            "-env:UserInstallation=" + profile_uri,
            "--headless",
            "--convert-to",
            "pdf",
            "--outdir",
            OUT,
            docx_path,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    name = os.path.splitext(os.path.basename(docx_path))[0] + ".pdf"
    return os.path.join(OUT, name)


def extract_docx_paragraph_anchors(docx_path):
    from docx import Document

    doc = Document(docx_path)
    anchors = []
    for idx, p in enumerate(doc.paragraphs):
        m = ANCHOR_RE.search(p.text)
        if m:
            anchors.append({
                "para_index": idx,
                "anchor": m.group(0),
                "truth_page": int(m.group(2)),
            })
    return anchors


def extract_pdf_page_anchors(pdf_path):
    import pdfplumber

    page_of_anchor = {}
    page_boxes = []
    with pdfplumber.open(pdf_path) as pdf:
        for pno, page in enumerate(pdf.pages, start=1):
            page_boxes.append({
                "page": pno,
                "width": round(page.width, 2),
                "height": round(page.height, 2),
            })
            text = page.extract_text() or ""
            for m in ANCHOR_RE.finditer(text):
                anchor = m.group(0)
                if anchor not in page_of_anchor:
                    page_of_anchor[anchor] = pno
    return page_of_anchor, page_boxes


def evaluate(docx_path):
    pdf_path = convert_to_pdf(docx_path)
    docx_anchors = extract_docx_paragraph_anchors(docx_path)
    measured_page, page_boxes = extract_pdf_page_anchors(pdf_path)

    total = 0
    correct = 0
    misses = []
    for a in docx_anchors:
        total += 1
        got = measured_page.get(a["anchor"])
        if got == a["truth_page"]:
            correct += 1
        else:
            misses.append({
                "anchor": a["anchor"],
                "para_index": a["para_index"],
                "truth_page": a["truth_page"],
                "measured_page": got,
            })
    acc = (correct / total * 100.0) if total else 0.0
    return {
        "file": os.path.basename(docx_path),
        "pdf_pages": len(page_boxes),
        "page_boxes": page_boxes,
        "anchor_paragraphs": total,
        "correct": correct,
        "accuracy_pct": round(acc, 2),
        "misses": misses,
    }


def evaluate_natural(docx_path):
    pdf_path = convert_to_pdf(docx_path)
    docx_anchors = extract_docx_paragraph_anchors(docx_path)
    measured_page, page_boxes = extract_pdf_page_anchors(pdf_path)

    seq = []
    unmapped = []
    for a in docx_anchors:
        m = ANCHOR_RE.search(a["anchor"])
        order = int(m.group(3))
        pg = measured_page.get(a["anchor"])
        if pg is None:
            unmapped.append(a["anchor"])
        else:
            seq.append((order, pg))

    seq.sort(key=lambda x: x[0])
    monotonic = all(seq[k][1] >= seq[k - 1][1] for k in range(1, len(seq)))
    pages_used = sorted(set(p for _, p in seq))
    contiguous = pages_used == list(range(1, len(page_boxes) + 1))
    complete = len(unmapped) == 0

    return {
        "file": os.path.basename(docx_path),
        "mode": "natural",
        "pdf_pages": len(page_boxes),
        "anchor_paragraphs": len(docx_anchors),
        "mapped": len(seq),
        "unmapped": unmapped,
        "monotonic": monotonic,
        "pages_used": pages_used,
        "contiguous": contiguous,
        "complete": complete,
        "pass": complete and monotonic and contiguous,
    }


def main():
    files = ["simple.docx", "medium.docx", "complex.docx"]
    results = []
    for f in files:
        path = os.path.join(SAMPLES, f)
        if not os.path.exists(path):
            print(f"[SKIP] 样本不存在: {path}")
            continue
        r = evaluate(path)
        results.append(r)
        print(f"=== {r['file']} ===")
        print(f"  PDF 页数: {r['pdf_pages']}  页尺寸: {r['page_boxes'][0] if r['page_boxes'] else 'N/A'}")
        print(f"  带锚点段落: {r['anchor_paragraphs']}  命中: {r['correct']}  准确率: {r['accuracy_pct']}%")
        if r["misses"]:
            print(f"  未命中 {len(r['misses'])} 处:")
            for m in r["misses"]:
                print(f"    {m['anchor']} 真值P{m['truth_page']} 实测P{m['measured_page']}")
        print()

    nat_path = os.path.join(SAMPLES, "natural.docx")
    nat = None
    if os.path.exists(nat_path):
        nat = evaluate_natural(nat_path)
        results.append(nat)
        print(f"=== {nat['file']} (自然分页) ===")
        print(f"  PDF 页数: {nat['pdf_pages']}  段落: {nat['anchor_paragraphs']}  已映射: {nat['mapped']}")
        print(f"  完备(无遗漏): {nat['complete']}  单调递增: {nat['monotonic']}  页连续: {nat['contiguous']}")
        print(f"  占用页: {nat['pages_used']}  判定: {'PASS' if nat['pass'] else 'FAIL'}")
        if nat["unmapped"]:
            print(f"  未映射: {nat['unmapped']}")
        print()

    os.makedirs(OUT, exist_ok=True)
    report_path = os.path.join(OUT, "mapping_result.json")
    with open(report_path, "w", encoding="utf-8") as fp:
        json.dump(results, fp, ensure_ascii=False, indent=2)
    print("结果 JSON:", report_path)

    simple = next((r for r in results if r["file"] == "simple.docx"), None)
    gate_simple = simple and simple["accuracy_pct"] >= 95.0
    gate_natural = (nat is None) or nat["pass"]
    if simple:
        print(f"\n门禁判定:")
        print(f"  简单文档准确率 ≥95%: {'PASS' if gate_simple else 'FAIL'} (simple={simple['accuracy_pct']}%)")
        print(f"  自然分页完备/单调/连续: {'PASS' if gate_natural else 'FAIL'}")
        return 0 if (gate_simple and gate_natural) else 1
    return 1


if __name__ == "__main__":
    sys.exit(main())
