// ONE writer for onnxruntime-web's environment, imported by every module that creates a session
// (vision.js, maia.js, maia2.js, maia3.js). The wasm backend initialises ONCE per document, at the first
// InferenceSession.create, with whatever env values are set at that moment -- so when each engine
// file wrote its own numThreads at import time, the thread count depended on which feature the user
// happened to touch first: a Maia engine opened before the first screen read silently reverted the
// recogniser to one thread and the measured 1109ms -> 620ms speedup never engaged. An ES module
// evaluates once however many times it is imported, which makes this file order-independent by
// construction.
//
// Thread count. Guarded on crossOriginIsolated: without SharedArrayBuffer anything above 1 fails to
// INITIALISE, and an engine that will not start is far worse than a slow one. Maia's forward pass is
// a few ms either way; the recogniser is the component this materially changes (measured 1.8x when
// it went from one thread to four).
//
// MEASURED on the position model, 7 fresh reads each, 10-core M-series Mac, otherwise idle:
//
//     threads   2      4       5      6      8
//     model   754ms  635ms   610ms  589ms  704ms
//
// So four was not the ceiling, and eight is WORSE than four -- past the physical cores the threads
// fight each other. 0.6 x cores, capped at 6, lands on the measured best here and changes nothing
// below ten cores: 4 cores still get 2, 8 cores still get 4. That matters because the numbers above
// are ONE machine, idle; a smaller box has no headroom to find and would only lose to contention.
// Worth 46ms of a ~635ms read -- real, small, and free.
import * as ort from '/lib/ort/ort.wasm.bundle.min.mjs';

ort.env.wasm.wasmPaths = '/lib/ort/';
// ...and then OVERRULED by a budget, because that argument optimises the wrong thing. The numbers
// above are ONE read in isolation; following a board runs that read over and over, and six threads
// held for as long as it follows is half a machine to watch something that changes every few
// seconds. What matters is not how fast one read is but how much of the machine the feature may
// take -- so the ceiling is a COUNT OF CORES, and the speed is whatever that buys. Two threads read
// in ~754ms against ~589ms at six: barely slower per read, a third of the cores. Fixed at two: the
// Screen Reader Cores setting that could change it is gone.
const VISION_THREADS = 2;
const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
ort.env.wasm.numThreads = isolated ? VISION_THREADS : 1;
ort.env.wasm.proxy = false;

// THE THREAD COUNT IS READ ONCE PER DOCUMENT, at the FIRST InferenceSession.create. With the count
// fixed above at import, nothing is left to wait for; every session creator still awaits this, so a
// setting that needs an await could come back without touching them.
function readyEnv() {
    return Promise.resolve();
}

export { ort, readyEnv, VISION_THREADS };
