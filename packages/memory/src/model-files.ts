/** File sizes and LFS SHA-256 from the pinned upstream model revisions. */
export const MODEL_FILES: Record<string, Record<string, { bytes: number; sha256: string }>> = {
  "gemma": {
    "onnx/audio_encoder_quantized.onnx": {
      "bytes": 249330,
      "sha256": "04a9a9094ba76fb169e4c69be45a4b621580188654d6be59eab860eadcd42d3c"
    },
    "onnx/audio_encoder_quantized.onnx_data": {
      "bytes": 340058624,
      "sha256": "aa6361d898e1f1d6303f8dd2b5fabf4fd3629e15fd709e9cb06ac5cb9416a030"
    },
    "onnx/model_quantized.onnx": {
      "bytes": 495165,
      "sha256": "d06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953"
    },
    "onnx/model_quantized.onnx_data": {
      "bytes": 313724928,
      "sha256": "278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b"
    },
    "onnx/vision_encoder_quantized.onnx": {
      "bytes": 162495,
      "sha256": "bb0de2df53a2448a32dc7908a187c168c8afd514d4d6f674f7f46024875fa4e3"
    },
    "onnx/vision_encoder_quantized.onnx_data": {
      "bytes": 195228672,
      "sha256": "3dabd69c0a36e9a8771ad82030dde74daa5a0e02b7047a5d3f3382b1137bab89"
    }
  },
  "speech": {
    "onnx/decoder_model_merged_quantized.onnx": {
      "bytes": 53693315,
      "sha256": "fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b"
    },
    "onnx/encoder_model_quantized.onnx": {
      "bytes": 23201314,
      "sha256": "5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46"
    }
  }
}
