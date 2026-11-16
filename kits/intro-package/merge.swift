// Merge PDFs in order: swift merge.swift out.pdf a.pdf b.pdf ...
import PDFKit
let a = CommandLine.arguments
guard a.count >= 3 else { fatalError("usage: merge.swift out.pdf in1.pdf [in2.pdf ...]") }
let out = PDFDocument()
for path in a[2...] {
  guard let d = PDFDocument(url: URL(fileURLWithPath: path)) else { fatalError("cannot read \(path)") }
  for i in 0..<d.pageCount { out.insert(d.page(at: i)!, at: out.pageCount) }
}
guard out.write(to: URL(fileURLWithPath: a[1])) else { fatalError("cannot write \(a[1])") }
print("merged \(out.pageCount) pages -> \(a[1])")
