import Foundation
import AVFoundation
import FluidAudio

struct Request: Decodable {
    let id: String?
    let op: String
    let audioPath: String?
    let language: String?
    let modelVersion: String?
    let sessionId: String?
    let variant: String?
    let pcmBase64: String?
    let sampleRate: Double?
    let channels: Int?
}

struct Response: Encodable {
    let id: String?
    let ok: Bool
    let text: String?
    let model: String?
    let engine: String?
    let sessionId: String?
    let variant: String?
    let partial: Bool?
    let final: Bool?
    let confidence: Float?
    let audioDurationMs: Int?
    let workerDurationMs: Int?
    let error: String?
}

struct StreamingSession {
    let id: String
    let variant: StreamingModelVariant
    let manager: any StreamingAsrManager
    let startedAt: Date
    var samplesReceived: Int
    var sampleRate: Double
}

actor FluidAsrService {
    private var manager: AsrManager?
    private var loadedVersion = ""
    private var streamingManager: (any StreamingAsrManager)?
    private var loadedStreamingVariant: StreamingModelVariant?
    private var streamingSession: StreamingSession?

    func warm(version: String) async throws {
        let normalized = normalizeVersion(version)
        if manager != nil, loadedVersion == normalized {
            return
        }

        let modelVersion = asrModelVersion(normalized)
        let models = try await AsrModels.downloadAndLoad(version: modelVersion)
        let nextManager = AsrManager(config: .default)
        try await nextManager.loadModels(models)
        manager = nextManager
        loadedVersion = normalized
    }

    func transcribe(audioPath: String, version: String, language: String?) async throws -> Response {
        try await warm(version: version)
        guard let manager else {
            throw HelperError.message("FluidAudio ASR manager is not initialized.")
        }

        let started = Date()
        let layers = await manager.decoderLayerCount
        var decoderState = TdtDecoderState.make(decoderLayers: layers)
        let result = try await manager.transcribe(
            URL(fileURLWithPath: audioPath),
            decoderState: &decoderState,
            language: fluidLanguage(language)
        )
        let elapsedMs = Int(Date().timeIntervalSince(started) * 1000)
        let audioDurationMs = Int(result.duration * 1000)

        return Response(
            id: nil,
            ok: true,
            text: result.text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines),
            model: "FluidAudio Parakeet TDT \(loadedVersion)",
            engine: "fluid-parakeet",
            sessionId: nil,
            variant: nil,
            partial: nil,
            final: nil,
            confidence: result.confidence,
            audioDurationMs: audioDurationMs,
            workerDurationMs: max(elapsedMs, Int(result.processingTime * 1000)),
            error: nil
        )
    }

    func warmStreaming(variant: String?) async throws -> Response {
        let started = Date()
        let resolvedVariant = streamingVariant(variant)

        if streamingManager == nil || loadedStreamingVariant != resolvedVariant {
            if let existingManager = streamingManager {
                await existingManager.cleanup()
            }
            let nextManager = resolvedVariant.createManager()
            try await nextManager.loadModels()
            streamingManager = nextManager
            loadedStreamingVariant = resolvedVariant
        }

        return Response(
            id: nil,
            ok: true,
            text: "",
            model: resolvedVariant.displayName,
            engine: "fluid-streaming",
            sessionId: nil,
            variant: resolvedVariant.rawValue,
            partial: false,
            final: false,
            confidence: nil,
            audioDurationMs: nil,
            workerDurationMs: Int(Date().timeIntervalSince(started) * 1000),
            error: nil
        )
    }

    func streamStart(sessionId: String, variant: String?) async throws -> Response {
        let started = Date()
        let warmResponse = try await warmStreaming(variant: variant)
        guard let streamManager = streamingManager else {
            throw HelperError.message("FluidAudio streaming manager is not initialized.")
        }

        try await streamManager.reset()
        let resolvedVariant = streamingVariant(warmResponse.variant)
        streamingSession = StreamingSession(
            id: sessionId,
            variant: resolvedVariant,
            manager: streamManager,
            startedAt: Date(),
            samplesReceived: 0,
            sampleRate: 16000
        )

        return Response(
            id: nil,
            ok: true,
            text: "",
            model: resolvedVariant.displayName,
            engine: "fluid-streaming",
            sessionId: sessionId,
            variant: resolvedVariant.rawValue,
            partial: false,
            final: false,
            confidence: nil,
            audioDurationMs: nil,
            workerDurationMs: Int(Date().timeIntervalSince(started) * 1000),
            error: nil
        )
    }

    func streamAudio(
        sessionId: String,
        pcmBase64: String,
        sampleRate: Double,
        channels: Int
    ) async throws -> Response {
        let started = Date()
        guard var session = streamingSession, session.id == sessionId else {
            throw HelperError.message("Streaming session is not active.")
        }
        guard channels == 1 else {
            throw HelperError.message("Streaming audio must be mono.")
        }

        let buffer = try pcmBuffer(fromBase64: pcmBase64, sampleRate: sampleRate)
        let frames = Int(buffer.frameLength)
        try await session.manager.appendAudio(buffer)
        try await session.manager.processBufferedAudio()
        let text = await session.manager.getPartialTranscript()

        session.samplesReceived += frames
        session.sampleRate = sampleRate
        streamingSession = session

        return Response(
            id: nil,
            ok: true,
            text: text.trimmingCharacters(in: .whitespacesAndNewlines),
            model: session.variant.displayName,
            engine: "fluid-streaming",
            sessionId: sessionId,
            variant: session.variant.rawValue,
            partial: true,
            final: false,
            confidence: nil,
            audioDurationMs: Int((Double(session.samplesReceived) / max(sampleRate, 1)) * 1000),
            workerDurationMs: Int(Date().timeIntervalSince(started) * 1000),
            error: nil
        )
    }

    func streamFinish(sessionId: String) async throws -> Response {
        let started = Date()
        guard let session = streamingSession, session.id == sessionId else {
            throw HelperError.message("Streaming session is not active.")
        }

        let text = try await session.manager.finish()
        streamingSession = nil

        return Response(
            id: nil,
            ok: true,
            text: text.trimmingCharacters(in: .whitespacesAndNewlines),
            model: session.variant.displayName,
            engine: "fluid-streaming",
            sessionId: sessionId,
            variant: session.variant.rawValue,
            partial: false,
            final: true,
            confidence: nil,
            audioDurationMs: Int((Double(session.samplesReceived) / max(session.sampleRate, 1)) * 1000),
            workerDurationMs: Int(Date().timeIntervalSince(started) * 1000),
            error: nil
        )
    }

    func streamCancel(sessionId: String?) async -> Response {
        let session = streamingSession
        streamingSession = nil
        if let manager = session?.manager {
            try? await manager.reset()
        }

        return Response(
            id: nil,
            ok: true,
            text: "",
            model: session?.variant.displayName,
            engine: "fluid-streaming",
            sessionId: sessionId ?? session?.id,
            variant: session?.variant.rawValue,
            partial: false,
            final: true,
            confidence: nil,
            audioDurationMs: nil,
            workerDurationMs: 0,
            error: nil
        )
    }

    private func normalizeVersion(_ value: String) -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized == "v2" || normalized.contains("0.6b-v2") {
            return "v2"
        }
        return "v3"
    }

    private func asrModelVersion(_ value: String) -> AsrModelVersion {
        value == "v2" ? .v2 : .v3
    }

    private func fluidLanguage(_ value: String?) -> Language? {
        let normalized = String(value ?? "").trimmingCharacters(in: CharacterSet.whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty, normalized != "auto" else {
            return nil
        }
        return Language(rawValue: normalized)
    }

    private func streamingVariant(_ value: String?) -> StreamingModelVariant {
        let normalized = String(value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return StreamingModelVariant(rawValue: normalized) ?? .parakeetUnified320ms
    }

    nonisolated private func pcmBuffer(fromBase64 base64: String, sampleRate: Double) throws -> AVAudioPCMBuffer {
        guard let data = Data(base64Encoded: base64), !data.isEmpty else {
            throw HelperError.message("Streaming audio chunk is empty or invalid.")
        }
        guard data.count % MemoryLayout<Float>.size == 0 else {
            throw HelperError.message("Streaming audio chunk must be Float32 PCM.")
        }

        let frameCount = data.count / MemoryLayout<Float>.size
        guard frameCount > 0 else {
            throw HelperError.message("Streaming audio chunk has no frames.")
        }

        var samples = [Float](repeating: 0, count: frameCount)
        samples.withUnsafeMutableBytes { destination in
            _ = data.copyBytes(to: destination)
        }

        guard let format = AVAudioFormat(
            standardFormatWithSampleRate: sampleRate > 0 ? sampleRate : 48000,
            channels: 1
        ) else {
            throw HelperError.message("Could not create streaming audio format.")
        }
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(frameCount)
        ) else {
            throw HelperError.message("Could not create streaming audio buffer.")
        }

        buffer.frameLength = AVAudioFrameCount(frameCount)
        if let channel = buffer.floatChannelData?[0] {
            samples.withUnsafeBufferPointer { source in
                if let base = source.baseAddress {
                    channel.update(from: base, count: frameCount)
                }
            }
        }
        return buffer
    }
}

enum HelperError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message):
            return message
        }
    }
}

let service = FluidAsrService()
let decoder = JSONDecoder()
let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]

func writeResponse(_ response: Response) {
    do {
        let data = try encoder.encode(response)
        if let line = String(data: data, encoding: .utf8) {
            print(line)
            fflush(stdout)
        }
    } catch {
        let fallback = #"{"id":null,"ok":false,"text":null,"model":null,"engine":"fluid-parakeet","confidence":null,"audioDurationMs":null,"workerDurationMs":null,"error":"Failed to encode helper response."}"#
        print(fallback)
        fflush(stdout)
    }
}

func errorResponse(id: String?, _ error: Error) -> Response {
    Response(
        id: id,
        ok: false,
        text: nil,
        model: nil,
        engine: "fluid-parakeet",
        sessionId: nil,
        variant: nil,
        partial: nil,
        final: nil,
        confidence: nil,
        audioDurationMs: nil,
        workerDurationMs: nil,
        error: error.localizedDescription
    )
}

Task {
    while let line = readLine(strippingNewline: true) {
        let request: Request
        do {
            guard let data = line.data(using: .utf8) else {
                throw HelperError.message("Request was not valid UTF-8.")
            }
            request = try decoder.decode(Request.self, from: data)
        } catch {
            writeResponse(errorResponse(id: nil, error))
            continue
        }

        do {
            switch request.op {
            case "warm":
                let started = Date()
                let version = request.modelVersion ?? "v3"
                try await service.warm(version: version)
                writeResponse(Response(
                    id: request.id,
                    ok: true,
                    text: "",
                    model: "FluidAudio Parakeet TDT \(version.lowercased() == "v2" ? "v2" : "v3")",
                    engine: "fluid-parakeet",
                    sessionId: nil,
                    variant: nil,
                    partial: nil,
                    final: nil,
                    confidence: nil,
                    audioDurationMs: nil,
                    workerDurationMs: Int(Date().timeIntervalSince(started) * 1000),
                    error: nil
                ))
            case "transcribe":
                guard let audioPath = request.audioPath, !audioPath.isEmpty else {
                    throw HelperError.message("Missing audioPath.")
                }
                var response = try await service.transcribe(
                    audioPath: audioPath,
                    version: request.modelVersion ?? "v3",
                    language: request.language
                )
                response = Response(
                    id: request.id,
                    ok: response.ok,
                    text: response.text,
                    model: response.model,
                    engine: response.engine,
                    sessionId: response.sessionId,
                    variant: response.variant,
                    partial: response.partial,
                    final: response.final,
                    confidence: response.confidence,
                    audioDurationMs: response.audioDurationMs,
                    workerDurationMs: response.workerDurationMs,
                    error: response.error
                )
                writeResponse(response)
            case "stream_start":
                let sessionId = request.sessionId ?? UUID().uuidString
                var response = try await service.streamStart(
                    sessionId: sessionId,
                    variant: request.variant
                )
                response = Response(
                    id: request.id,
                    ok: response.ok,
                    text: response.text,
                    model: response.model,
                    engine: response.engine,
                    sessionId: response.sessionId,
                    variant: response.variant,
                    partial: response.partial,
                    final: response.final,
                    confidence: response.confidence,
                    audioDurationMs: response.audioDurationMs,
                    workerDurationMs: response.workerDurationMs,
                    error: response.error
                )
                writeResponse(response)
            case "stream_warm":
                var response = try await service.warmStreaming(variant: request.variant)
                response = Response(
                    id: request.id,
                    ok: response.ok,
                    text: response.text,
                    model: response.model,
                    engine: response.engine,
                    sessionId: response.sessionId,
                    variant: response.variant,
                    partial: response.partial,
                    final: response.final,
                    confidence: response.confidence,
                    audioDurationMs: response.audioDurationMs,
                    workerDurationMs: response.workerDurationMs,
                    error: response.error
                )
                writeResponse(response)
            case "stream_audio":
                guard let sessionId = request.sessionId, !sessionId.isEmpty else {
                    throw HelperError.message("Missing sessionId.")
                }
                guard let pcmBase64 = request.pcmBase64, !pcmBase64.isEmpty else {
                    throw HelperError.message("Missing pcmBase64.")
                }
                var response = try await service.streamAudio(
                    sessionId: sessionId,
                    pcmBase64: pcmBase64,
                    sampleRate: request.sampleRate ?? 48000,
                    channels: request.channels ?? 1
                )
                response = Response(
                    id: request.id,
                    ok: response.ok,
                    text: response.text,
                    model: response.model,
                    engine: response.engine,
                    sessionId: response.sessionId,
                    variant: response.variant,
                    partial: response.partial,
                    final: response.final,
                    confidence: response.confidence,
                    audioDurationMs: response.audioDurationMs,
                    workerDurationMs: response.workerDurationMs,
                    error: response.error
                )
                writeResponse(response)
            case "stream_finish":
                guard let sessionId = request.sessionId, !sessionId.isEmpty else {
                    throw HelperError.message("Missing sessionId.")
                }
                var response = try await service.streamFinish(sessionId: sessionId)
                response = Response(
                    id: request.id,
                    ok: response.ok,
                    text: response.text,
                    model: response.model,
                    engine: response.engine,
                    sessionId: response.sessionId,
                    variant: response.variant,
                    partial: response.partial,
                    final: response.final,
                    confidence: response.confidence,
                    audioDurationMs: response.audioDurationMs,
                    workerDurationMs: response.workerDurationMs,
                    error: response.error
                )
                writeResponse(response)
            case "stream_cancel":
                var response = await service.streamCancel(sessionId: request.sessionId)
                response = Response(
                    id: request.id,
                    ok: response.ok,
                    text: response.text,
                    model: response.model,
                    engine: response.engine,
                    sessionId: response.sessionId,
                    variant: response.variant,
                    partial: response.partial,
                    final: response.final,
                    confidence: response.confidence,
                    audioDurationMs: response.audioDurationMs,
                    workerDurationMs: response.workerDurationMs,
                    error: response.error
                )
                writeResponse(response)
            default:
                throw HelperError.message("Unsupported operation: \(request.op)")
            }
        } catch {
            writeResponse(errorResponse(id: request.id, error))
        }
    }
    exit(0)
}

dispatchMain()
