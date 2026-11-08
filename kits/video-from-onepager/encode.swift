import AVFoundation
import AppKit

// usage: encode <frames dir> <fps> <out.mp4> [audio.wav]
let args = CommandLine.arguments
guard args.count >= 4, let fps = Int32(args[2]) else { print("usage: encode <dir> <fps> <out.mp4> [audio.wav]"); exit(1) }
let dir = args[1], outURL = URL(fileURLWithPath: args[3])
let files = try FileManager.default.contentsOfDirectory(atPath: dir).filter { $0.hasSuffix(".png") }.sorted()
guard !files.isEmpty else { print("no frames"); exit(1) }
try? FileManager.default.removeItem(at: outURL)

let w = 1920, h = 1080
let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
  AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2, AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2],
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 12_000_000, AVVideoQualityKey: 0.95, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel],
])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
  kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
])
writer.add(input)

// optional audio: read the WAV as LPCM, write as AAC
var audioIn: AVAssetWriterInput?
var reader: AVAssetReader?
var readerOut: AVAssetReaderTrackOutput?
if args.count >= 5 {
  let asset = AVURLAsset(url: URL(fileURLWithPath: args[4]))
  let sem0 = DispatchSemaphore(value: 0)
  var track: AVAssetTrack?
  Task { track = try? await asset.loadTracks(withMediaType: .audio).first; sem0.signal() }
  sem0.wait()
  guard let t = track else { print("no audio track"); exit(1) }
  reader = try AVAssetReader(asset: asset)
  readerOut = AVAssetReaderTrackOutput(track: t, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 2])
  reader!.add(readerOut!)
  audioIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [
    AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192_000])
  writer.add(audioIn!)
  reader!.startReading()
}
writer.startWriting()
writer.startSession(atSourceTime: .zero)

func pumpAudio(upTo seconds: Double) {
  guard let ai = audioIn, let ro = readerOut else { return }
  while ai.isReadyForMoreMediaData, reader!.status == .reading {
    guard let sb = ro.copyNextSampleBuffer() else { ai.markAsFinished(); return }
    ai.append(sb)
    if CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb)) > seconds { return }
  }
}

func buffer(_ path: String) -> CVPixelBuffer? {
  guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
  var pb: CVPixelBuffer?
  CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32ARGB, nil, &pb)
  guard let b = pb else { return nil }
  CVPixelBufferLockBaseAddress(b, [])
  let ctx = CGContext(data: CVPixelBufferGetBaseAddress(b), width: w, height: h, bitsPerComponent: 8,
                      bytesPerRow: CVPixelBufferGetBytesPerRow(b), space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)
  ctx?.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
  CVPixelBufferUnlockBaseAddress(b, [])
  return b
}

for (i, f) in files.enumerated() {
  while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.005) }
  guard let b = buffer("\(dir)/\(f)") else { print("bad frame \(f)"); exit(1) }
  adaptor.append(b, withPresentationTime: CMTime(value: Int64(i), timescale: fps))
  pumpAudio(upTo: Double(i) / Double(fps) + 0.5)
}
input.markAsFinished()
if let ai = audioIn, let ro = readerOut {
  while reader!.status == .reading {
    while !ai.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.005) }
    guard let sb = ro.copyNextSampleBuffer() else { break }
    ai.append(sb)
  }
  ai.markAsFinished()
}
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
print(writer.status == .completed ? "wrote \(args[3]) (\(files.count) frames)" : "failed: \(String(describing: writer.error))")
