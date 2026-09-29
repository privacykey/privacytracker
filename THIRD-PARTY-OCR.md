# Third-party components: screenshot import (OCR)

Screenshot import reads app names out of screenshots inside the browser. No
image is uploaded, and nothing is fetched from a third party: the files that
do the reading are served by privacytracker itself from `/ocr/`, copied at
build time from the npm packages below by `scripts/stage-ocr-assets.mjs`.
That script also places this notice and the licence texts named here beside
the files in `/ocr/`. The version of each package is listed on the app's
Legal page (`/legal`).

## tesseract.js

- Shipped as: `worker.min.js`, the script the OCR worker runs.
- Licence: Apache License 2.0. Text: `LICENSE-tesseract.js.txt`.
- Source: https://github.com/naptha/tesseract.js
- `worker.min.js` bundles a few small libraries of its own. Their notices
  ship beside it as `worker.min.js.LICENSE.txt`.

## tesseract.js-core

- Shipped as: `tesseract-core-lstm.wasm.js`,
  `tesseract-core-simd-lstm.wasm.js` and
  `tesseract-core-relaxedsimd-lstm.wasm.js`, three builds of one engine.
  tesseract.js loads the one the browser supports.
- Licence: Apache License 2.0. Text: `LICENSE-tesseract.js-core.txt`.
- Source: https://github.com/naptha/tesseract.js-core
- The engine is compiled to WebAssembly from these projects, each under its
  own licence:
  - Tesseract OCR (Apache License 2.0), https://github.com/tesseract-ocr/tesseract
  - Leptonica (BSD 2-Clause), https://github.com/DanBloomberg/leptonica
  - libjpeg (Independent JPEG Group licence). This software is based in
    part on the work of the Independent JPEG Group.
  - libpng (libpng licence), https://github.com/glennrp/libpng
  - libtiff (libtiff licence), https://gitlab.com/libtiff/libtiff
  - libwebp (BSD 3-Clause), https://github.com/webmproject/libwebp
  - giflib (MIT), https://sourceforge.net/projects/giflib/
  - zlib (zlib licence), https://github.com/madler/zlib
  - openlibm (MIT and BSD-style licences), https://github.com/JuliaMath/openlibm

## English language model

- Shipped as: `eng.traineddata.gz`.
- Taken from the npm package `@tesseract.js-data/eng` (its `4.0.0_best_int`
  file), published from https://github.com/naptha/tessdata. The package
  declares the MIT licence; the repository is under the Apache License 2.0.
- The model is the integer version of Tesseract's English LSTM model from
  https://github.com/tesseract-ocr/tessdata_best, which is licensed under the
  Apache License 2.0.
