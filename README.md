# ShadiFlow

ShadiFlow is a desktop voice dictation app for AI-style dictation workflows:
local or cloud audio transcription, rough-to-polished rewriting, snippets,
personal vocabulary, target surfaces, saved sessions, and paste insertion.

## Desktop app

Install dependencies once:

```bash
npm install
```

Run in development:

```bash
npm start
```

Package a macOS app:

```bash
npm run package
```

The packaged app is created at:

```text
dist/mac-arm64/ShadiFlow.app
```

## Local open-source mode

ShadiFlow runs fully locally. This build defaults to MLX Parakeet TDT 0.6B v3
for fast Apple Silicon transcription, with MLX Whisper Large V3 Turbo available
as the fallback path for unsupported languages.

```text
Default transcription provider: MLX Parakeet TDT 0.6B v3
Fallback transcription provider: MLX Whisper Large V3 Turbo
Language: selectable in Settings
Formatting: built-in local rules
```

MLX runtime used by the packaged app:

```text
~/Library/Application Support/shadi-flow/runtimes/mlx-whisper
~/Library/Application Support/shadi-flow/runtime-cache/huggingface
```

On Apple Silicon, ShadiFlow warms the MLX model immediately after launch and
keeps one worker process alive for fast background dictation.

OpenAI Whisper CLI fallback runtime:

```bash
brew install ffmpeg
pipx install openai-whisper
```

If you prefer whisper.cpp, set:

```text
Local Whisper command: whisper-cli
whisper.cpp model path: /path/to/ggml-model.bin
```

For a custom local transcription command, use Custom Whisper args. Available
placeholders are:

```text
{audio} {wav} {dir} {outbase} {model} {language}
```

Global shortcut:

```text
CommandOrControl+Shift+Space
```

On macOS, automatic paste insertion may require Accessibility permission for
ShadiFlow. If permission is missing, text is still copied to the clipboard.

## Optional browser mode

The old local browser mode is still available for quick testing:

```bash
python3 server.py
```

Then open `http://localhost:8080`.

The desktop app is the supported Whisper-only experience. The browser mode is
kept for layout testing and may fall back to the browser's Web Speech API.
