/**
 * Local voice (§7): STT with whisper.cpp, TTS with Supertonic 3 (best-quality
 * local model), run IN-PROCESS via onnxruntime-node — no Python, no phonemizer.
 *
 * Pipeline:
 *   voice-in:  ogg → ffmpeg (16k mono wav) → whisper-cli → transcript
 *   voice-out: text → Supertonic ONNX (in-process) → wav → ffmpeg (OGG/Opus 48k)
 *
 * whisper models + Supertonic ONNX weights download on first use into the data
 * dir. ffmpeg + whisper-cli come from the Nix flake devShell; Supertonic is the
 * `onnxruntime-node` npm dep + vendored runner (vendor/supertonic).
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadTextToSpeech, loadVoiceStyle, type Style, type TextToSpeech, writeWavFile } from "../vendor/supertonic/helper.js";
import { errFields, log } from "./log.ts";

const WHISPER_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const SUPERTONIC_BASE = "https://huggingface.co/Supertone/supertonic-3/resolve/main";
const SUPERTONIC_ONNX = ["duration_predictor.onnx", "text_encoder.onnx", "vector_estimator.onnx", "vocoder.onnx", "tts.json", "unicode_indexer.json"];
const TTS_STEPS = 8; // denoising steps (quality vs speed)
const TTS_SPEED = 1.05; // Supertonic's recommended default

export interface VoiceConfig {
  modelsDir: string;
  /** whisper.cpp ggml model name, e.g. "large-v3-turbo" or "base.en". */
  whisperModel: string;
  /** Supertonic voice style id, e.g. "M1", "F1". */
  supertonicVoice: string;
}

async function download(url: string, dest: string) {
  log.info("downloading voice model", { url });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed (HTTP ${res.status}): ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/** Run a subprocess, throwing on nonzero exit; returns stdout. */
async function run(cmd: string[], stdin?: Uint8Array): Promise<string> {
  const proc = Bun.spawn(cmd, { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${stderr.slice(0, 500)}`);
  return stdout;
}

export class Voice {
  private readonly whisperModelPath: string;
  private readonly onnxDir: string;
  private readonly voiceStylePath: string;
  private ttsPromise?: Promise<{ tts: TextToSpeech; style: Style }>;

  constructor(private readonly cfg: VoiceConfig) {
    mkdirSync(cfg.modelsDir, { recursive: true });
    this.whisperModelPath = join(cfg.modelsDir, `ggml-${cfg.whisperModel}.bin`);
    this.onnxDir = join(cfg.modelsDir, "supertonic", "onnx");
    this.voiceStylePath = join(cfg.modelsDir, "supertonic", "voice_styles", `${cfg.supertonicVoice}.json`);
  }

  // ---- STT (whisper.cpp) ----

  private async ensureStt() {
    if (!existsSync(this.whisperModelPath)) {
      await download(`${WHISPER_BASE}/ggml-${this.cfg.whisperModel}.bin`, this.whisperModelPath);
    }
  }

  async transcribe(inputPath: string, workdir: string): Promise<string> {
    await this.ensureStt();
    const wav = join(workdir, "stt.wav");
    const outPrefix = join(workdir, "stt");
    await run(["ffmpeg", "-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", wav]);
    await run(["whisper-cli", "-m", this.whisperModelPath, "-f", wav, "-nt", "-np", "-l", "auto", "-otxt", "-of", outPrefix]);
    return (await readFile(`${outPrefix}.txt`, "utf8")).trim();
  }

  // ---- TTS (Supertonic, in-process) ----

  private async ensureTtsAssets() {
    mkdirSync(this.onnxDir, { recursive: true });
    mkdirSync(join(this.onnxDir, "..", "voice_styles"), { recursive: true });
    for (const f of SUPERTONIC_ONNX) {
      const dest = join(this.onnxDir, f);
      if (!existsSync(dest)) await download(`${SUPERTONIC_BASE}/onnx/${f}`, dest);
    }
    if (!existsSync(this.voiceStylePath)) {
      await download(`${SUPERTONIC_BASE}/voice_styles/${this.cfg.supertonicVoice}.json`, this.voiceStylePath);
    }
  }

  /** Load the Supertonic ONNX sessions once, then reuse. */
  private loadTts(): Promise<{ tts: TextToSpeech; style: Style }> {
    if (!this.ttsPromise) {
      this.ttsPromise = (async () => {
        await this.ensureTtsAssets();
        const tts = await loadTextToSpeech(this.onnxDir, false);
        const style = loadVoiceStyle([this.voiceStylePath], false);
        log.info("supertonic ready", { voice: this.cfg.supertonicVoice, sampleRate: tts.sampleRate });
        return { tts, style };
      })().catch((e) => {
        this.ttsPromise = undefined; // allow retry on a later call
        throw e;
      });
    }
    return this.ttsPromise;
  }

  async synthesize(text: string, workdir: string): Promise<{ path: string; durationSec: number }> {
    mkdirSync(workdir, { recursive: true });
    const { tts, style } = await this.loadTts();
    const { wav, duration } = await tts.call(text, "en", style, TTS_STEPS, TTS_SPEED);
    const sr = tts.sampleRate;
    const secs = duration[0] ?? wav.length / sr;
    const wavLen = Math.min(wav.length, Math.max(1, Math.floor(sr * secs)));
    const clip = wav.slice(0, wavLen);

    const wavPath = join(workdir, "tts.wav");
    const ogg = join(workdir, "tts.ogg");
    writeWavFile(wavPath, clip, sr);
    await run(["ffmpeg", "-y", "-i", wavPath, "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", ogg]);
    return { path: ogg, durationSec: Math.max(1, Math.round(secs)) };
  }

  /** Best-effort warm-up at boot; logs but never throws. */
  async warmup() {
    try {
      await this.ensureStt();
      await this.loadTts();
      log.info("voice ready", { whisper: this.cfg.whisperModel, voice: this.cfg.supertonicVoice });
    } catch (e) {
      log.warn("voice warmup failed (voice may be unavailable)", errFields(e));
    }
  }
}
