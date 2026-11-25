/** Upstream ffmpeg-static b6.1.1 assets. Verify integrity before executing downloaded tools. */
export const DECODER_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1'
export const DECODER_ASSETS: Record<string, { name: string; bytes: number; sha256: string }[]> = {
  "darwin-arm64": [
    {
      "name": "darwin-arm64.LICENSE",
      "bytes": 4376,
      "sha256": "cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2"
    },
    {
      "name": "darwin-arm64.README",
      "bytes": 1810,
      "sha256": "05ba4b92c96605434b1aaae3eedf5a2c280c9607bf78ffca9a5b536d9af2dc6a"
    },
    {
      "name": "ffmpeg-darwin-arm64",
      "bytes": 45568216,
      "sha256": "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584"
    },
    {
      "name": "ffprobe-darwin-arm64",
      "bytes": 45528808,
      "sha256": "bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64"
    }
  ],
  "darwin-x64": [
    {
      "name": "darwin-x64.LICENSE",
      "bytes": 4346,
      "sha256": "2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af"
    },
    {
      "name": "darwin-x64.README",
      "bytes": 6227,
      "sha256": "e88a0325f8e5b75210355e37341824f074d3cd82def2125be54c914b62848a36"
    },
    {
      "name": "ffmpeg-darwin-x64",
      "bytes": 78862176,
      "sha256": "ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894"
    },
    {
      "name": "ffprobe-darwin-x64",
      "bytes": 78780408,
      "sha256": "fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0"
    }
  ],
  "linux-arm64": [
    {
      "name": "ffmpeg-linux-arm64",
      "bytes": 51134160,
      "sha256": "6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce"
    },
    {
      "name": "ffprobe-linux-arm64",
      "bytes": 50994160,
      "sha256": "d17ae9b4c297d48e2521ba14e417bb0537c6ff77c584cdbcd6bb0d8d0307a2e8"
    },
    {
      "name": "linux-arm64.LICENSE",
      "bytes": 35147,
      "sha256": "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903"
    },
    {
      "name": "linux-arm64.README",
      "bytes": 2217,
      "sha256": "d6777d2fd276b23f0ac6666fa619e88ffe4826521881c7ff83836e30cb4acec2"
    }
  ],
  "linux-x64": [
    {
      "name": "ffmpeg-linux-x64",
      "bytes": 79826272,
      "sha256": "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99"
    },
    {
      "name": "ffprobe-linux-x64",
      "bytes": 79665792,
      "sha256": "4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d"
    },
    {
      "name": "linux-x64.LICENSE",
      "bytes": 35147,
      "sha256": "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903"
    },
    {
      "name": "linux-x64.README",
      "bytes": 2235,
      "sha256": "72f4b1b06d419d22ace6e7cc75f06826f90737345aa0b1736158929f4aacc537"
    }
  ],
  "win32-x64": [
    {
      "name": "ffmpeg-win32-x64",
      "bytes": 82797568,
      "sha256": "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00"
    },
    {
      "name": "ffprobe-win32-x64",
      "bytes": 82668032,
      "sha256": "3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4"
    },
    {
      "name": "win32-x64.LICENSE",
      "bytes": 35147,
      "sha256": "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903"
    },
    {
      "name": "win32-x64.README",
      "bytes": 39494,
      "sha256": "a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311"
    }
  ]
}
