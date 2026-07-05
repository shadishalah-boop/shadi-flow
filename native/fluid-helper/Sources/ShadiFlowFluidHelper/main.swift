import Foundation
import FluidAudio

struct Request: Decodable {
    let id: String?
    let op: String
    let audioPath: String?
    let language: String?
    let modelVersion: String?
}

struct Response: Encodable {
    let id: String?
    let ok: Bool
    let text: String?
    let model: String?
    let engine: String?
    let confidence: Float?
    let audioDurationMs: Int?
    let workerDurationMs: Int?
    let error: String?
}

actor FluidAsrService {
    private var manager: AsrManager?
    private var loadedVersion = ""

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
            confidence: result.confidence,
            audioDurationMs: audioDurationMs,
            workerDurationMs: max(elapsedMs, Int(result.processingTime * 1000)),
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
