# Vendored: Supertonic TTS (Node/ONNX runner)

`helper.js` is vendored verbatim from https://github.com/supertone-inc/supertonic
(nodejs/helper.js), MIT-licensed — see LICENSE. It runs the Supertonic 3 ONNX
models in-process via `onnxruntime-node`. Model weights are fetched at runtime
from https://huggingface.co/Supertone/supertonic-3 into the data dir.

Only used exports: loadTextToSpeech, loadVoiceStyle, writeWavFile.
