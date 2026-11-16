#!/bin/zsh
# Build a prospect intro packet: personalized cover + one-pager + showcase cases, as one PDF.
# Usage: make-intro.sh <prospect.json> <out.pdf>
#   prospect.json lives in the prospect's ~/Projects/<Client>/intro/ folder (see README).
# Writes <out.pdf> and page previews in <out dir>/pdfprev/ to check before sending.
set -euo pipefail
KIT=${0:A:h}; PT=${KIT:h:h}
SPEC=${1:?usage: make-intro.sh prospect.json out.pdf}; OUT=${2:?usage: make-intro.sh prospect.json out.pdf}
SPEC=${SPEC:A}; OUT=${OUT:A}
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP=$(mktemp -d); trap 'rm -rf $TMP' EXIT
mkdir -p $TMP/brand && cp -R $PT/fonts $TMP/ && cp $PT/brand/positive-tribes-logo-horizontal.svg $TMP/brand/

# 1. Cover page from the template. Values are HTML-escaped; *emphasis* in the headline and ask becomes <em>.
CASES=$(python3 -I - "$KIT/cover.html" "$SPEC" "$TMP/cover.html" <<'PY'
import json,sys,html,re
tpl,spec,dst=sys.argv[1:]
p=json.load(open(spec))
for k in ("for","headline","why","ideas","ask"):
    if not p.get(k): sys.exit(f"prospect.json is missing '{k}'")
e=lambda s: re.sub(r'\*(.+?)\*',r'<em>\1</em>',html.escape(s))
cases=p.get("cases",[])
inside=['<li><b>Positive Tribes on one page:</b> what we build, how it works, and what changes for your team.</li>']
if cases: inside.append('<li><b>Work for other nonprofits:</b> results and real screens (sample data) from builds like yours.</li>')
inside.append('<li><b>See it in a minute:</b> a one-minute video at <a href="https://positivetribes.org">positivetribes.org</a>.</li>')
s=(open(tpl).read()
   .replace("{{FOR}}",html.escape(p["for"]))
   .replace("{{HEADLINE}}",e(p["headline"]))
   .replace("{{WHY}}","".join(f"<p>{html.escape(x)}</p>" for x in p["why"]))
   .replace("{{IDEAS}}","".join(f'<div class="idea"><h3>{html.escape(i["title"])}</h3><p>{html.escape(i["text"])}</p></div>' for i in p["ideas"][:4]))
   .replace("{{INSIDE}}","".join(inside))
   .replace("{{ASK}}",e(p["ask"])))
if "{{" in s: sys.exit("unfilled placeholder in cover")
open(dst,"w").write(s)
print(p.get("showcase_for",p.get("name","")) + "\t" + " ".join(cases))
PY
)
WHO=${CASES%%$'\t'*}; CASELIST=(${=CASES#*$'\t'})
"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --virtual-time-budget=5000 \
  --print-to-pdf="$TMP/1-cover.pdf" "file://$TMP/cover.html" 2>/dev/null

# 2. The one-pager (same PDF the website serves).
cp $PT/onesheet/positive-tribes-one-sheet.pdf $TMP/2-onesheet.pdf
PARTS=($TMP/1-cover.pdf $TMP/2-onesheet.pdf)

# 3. Showcase cases, if any.
if (( ${#CASELIST} )); then
  mkdir -p $TMP/sc && $KIT/../showcase/make-pdf.sh $TMP/sc/3-showcase.pdf --for "$WHO" $CASELIST >/dev/null
  PARTS+=($TMP/sc/3-showcase.pdf)
fi

swift $KIT/merge.swift "$OUT" $PARTS
mkdir -p ${OUT:h}/pdfprev && (cd ${OUT:h} && swift $KIT/../showcase/render-pages.swift "$OUT")
echo "PDF: $OUT  (previews: ${OUT:h}/pdfprev/)"
