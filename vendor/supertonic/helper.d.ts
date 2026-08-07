// Minimal type shim for the vendored Supertonic helper.js (only the exports we use).
export type Style = unknown;

export interface TextToSpeech {
  readonly sampleRate: number;
  call(text: string, lang: string, style: Style, totalStep: number, speed: number): Promise<{ wav: Float32Array; duration: number[] }>;
}

export function loadTextToSpeech(onnxDir: string, useGpu?: boolean): Promise<TextToSpeech>;
export function loadVoiceStyle(voiceStylePaths: string[], verbose?: boolean): Style;
export function writeWavFile(filename: string, audioData: Float32Array | number[], sampleRate: number): void;
