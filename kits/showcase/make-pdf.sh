#!/bin/zsh
# Make a prospect-ready PDF from showcase.html.
# Usage: make-pdf.sh <out.pdf> [--for "Prospect name"] [case ...]
#   cases: data-case ids in showcase.html (uep, safe). Default: all.
# Writes <out.pdf> and page previews in <out dir>/pdfprev/ to eyeball before sending.
set -euo pipefail
KIT=${0:A:h}; OUT=${1:?usage: make-pdf.sh out.pdf [--for name] [case ...]}; shift
OUT=${OUT:A}; FOR=""
if [[ ${1:-} == --for ]]; then FOR=$2; shift 2; fi
TMP=$(mktemp -d); trap 'rm -rf $TMP' EXIT
cp -R $KIT/img $KIT/print.css $TMP/
python3 -I - "$KIT/showcase.html" "$TMP/page.html" "$FOR" "$@" <<'PY'
import re,sys,html
src,dst,who,*keep=sys.argv[1:]
s=open(src).read()
ids=re.findall(r'data-case="([a-z0-9-]+)"',s)
bad=[k for k in keep if k not in ids]
if bad: sys.exit(f"unknown case(s) {bad}; have {ids}")
for c in ids:
    if keep and c not in keep:
        s=re.sub(r'<section data-case="%s".*?</section>\s*'%c,'',s,flags=re.S)
if who: s=s.replace('Positive Tribes · Fundraising work</div>',f'Positive Tribes · Prepared for {html.escape(who)}</div>',1)
open(dst,'w').write(s)
PY
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --no-pdf-header-footer --virtual-time-budget=5000 --print-to-pdf="$OUT" "file://$TMP/page.html" 2>/dev/null
mkdir -p ${OUT:h}/pdfprev && (cd ${OUT:h} && swift $KIT/render-pages.swift "$OUT")
echo "PDF: $OUT  (previews: ${OUT:h}/pdfprev/)"
