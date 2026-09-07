// ==========================================
// Content extraction (OCR + native text)
// ==========================================
// Item #4 of PAPRA_FEATURE_ROADMAP.md. Two-strategy fallback, same shape
// as Papra's content-extraction.usecases.ts (try each strategy in order,
// first one that produces text wins) but scaled down to two strategies
// instead of Papra's five cloud-provider chain -- this also resolves the
// previously-tabled OCR tooling decision: tesseract.js was chosen for
// ease of use (runs in-process, nothing extra to deploy/configure) and
// computational efficiency in the "cheap to run on a self-hosted box"
// sense, not "fastest possible" -- an acceptable trade given DocHandler
// has no Azure/Mistral API budget to reach for instead.
//
// Scope note: this module only extracts from files already sitting on
// local disk (i.e. the direct /upload path). Google Drive-attached
// documents are NOT covered by this pass -- extracting from those would
// mean downloading the file via the Drive API first, which is a bigger
// change than "add OCR" on its own. Noted in BACKLOG.md as a known gap
// rather than silently skipped without a paper trail.

const fs = require('fs');
const path = require('path');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif']);
const PDF_EXTENSION = '.pdf';
const PLAIN_TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv']);

// Strategy 1: native text extraction. Fast, free, no OCR needed at all for
// already-text-based files. Returns null (not '') if this strategy simply
// doesn't apply to the file type -- the caller uses that null/'' distinction
// to decide whether OCR is worth attempting as a fallback.
async function tryNativeTextExtraction(filePath, ext) {
    if (PLAIN_TEXT_EXTENSIONS.has(ext)) {
        return fs.readFileSync(filePath, 'utf8');
    }
    if (ext === PDF_EXTENSION) {
        // pdf-parse v2 changed its API entirely from v1 (a default
        // function export) to a PDFParse class -- confirmed via
        // smoke-testing against the actually-installed version rather
        // than assumed from memory of the older API.
        const { PDFParse } = require('pdf-parse');
        const buffer = fs.readFileSync(filePath);
        const parser = new PDFParse({ data: buffer });
        const result = await parser.getText();
        return result.text || '';
    }
    return null;
}

// Strategy 2: OCR fallback via tesseract.js. Used for image files outright,
// and for PDFs that came back empty from native extraction (i.e.
// scanned/image-only PDFs with no embedded text layer). English-only for
// now -- DocHandler's documents are predominantly English/Indonesian
// business documents; multi-language OCR is a straightforward extension
// (tesseract.js supports it) if Indonesian-language scans turn out to need
// it, not attempted here to keep this pass scoped.
//
// IMPORTANT (found via smoke-testing, not theoretical): tesseract.js's
// createWorker() downloads its language training data from
// cdn.jsdelivr.net on first use in each process, and if that network call
// fails for ANY reason (corporate firewall blocking the CDN, transient
// outage, DNS failure), the default behavior is NOT a rejected promise --
// it's an unhandled 'error' event that CRASHES THE ENTIRE NODE PROCESS,
// taking down all of DocHandler, not just that one OCR attempt. This is a
// real risk for a self-hosted internal tool that may not have (or may
// lose) egress to an external CDN. Passing `errorHandler` below is
// required, not optional, to prevent that. Separately, a failed worker
// load can also just hang forever rather than reject even with
// errorHandler set -- the explicit timeout below guards against that
// leaking a stuck worker indefinitely.
//
// Longer-term, the more robust fix is bundling the trained-data file
// locally (tesseract.js supports a `langPath` pointing at a local file)
// so OCR has zero runtime dependency on an external CDN at all -- flagged
// in BACKLOG.md as a follow-up rather than done here, since it requires
// shipping a ~15MB data file through the patch-based workflow this
// project uses, which needs a deliberate decision, not a silent addition.
const OCR_TIMEOUT_MS = 45000;

async function tryOcrExtraction(filePath) {
    const { createWorker } = require('tesseract.js');
    let workerError = null;

    const withTimeout = (promise, label) => Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`OCR ${label} timed out after ${OCR_TIMEOUT_MS}ms`)), OCR_TIMEOUT_MS)
        ),
    ]);

    // createWorker() itself is what actually hangs when the language-data
    // fetch fails (not recognize()) -- confirmed via smoke-testing, not
    // assumed. Both stages need the timeout wrapper, not just recognition.
    // If it times out, the underlying promise is still running in the
    // background (Promise.race can't cancel it) -- attach a trailing
    // .then() so that IF it eventually resolves, the orphaned worker
    // still gets terminated rather than leaking a worker_thread forever.
    // KNOWN RESIDUAL LIMITATION (smoke-tested, not theoretical): if the
    // fetch to cdn.jsdelivr.net never resolves OR rejects at all (as
    // opposed to failing with a clean error), the trailing .then() above
    // never fires either, and that one worker_thread leaks for the life
    // of the process. Bounded per failed OCR attempt, not unbounded
    // growth per request, and doesn't crash or hang the server itself --
    // but under sustained CDN unreachability this accumulates. The real
    // fix is bundling the trained-data file locally so OCR has zero
    // runtime dependency on an external CDN (see BACKLOG.md follow-up);
    // this timeout/errorHandler pair is a safety net, not a substitute
    // for that.
    const createWorkerPromise = createWorker('eng', 1, { errorHandler: (err) => { workerError = err; } });
    createWorkerPromise
        .then(w => w.terminate())
        .catch(() => {}); // no-op if it already succeeded via the main path below, or never resolves at all

    const worker = await withTimeout(createWorkerPromise, 'worker initialization');

    try {
        if (workerError) throw new Error(String(workerError));
        const { data } = await withTimeout(worker.recognize(filePath), 'recognition');
        if (workerError) throw new Error(String(workerError));
        return data.text || '';
    } finally {
        worker.terminate().catch(termErr => console.warn('OCR worker cleanup failed (non-fatal):', termErr.message));
    }
}


// Orchestrator. Returns { text, method } where method is one of:
// 'native'      -- got usable text without OCR
// 'ocr'         -- native extraction found nothing (or wasn't applicable), OCR did
// 'unsupported' -- neither strategy applies to this file type (e.g. .docx, .xlsx)
// 'error'       -- a strategy threw; logged, not fatal
async function extractDocumentContent(filePath, filename) {
    const ext = path.extname(filename).toLowerCase();
    try {
        const nativeResult = await tryNativeTextExtraction(filePath, ext);
        if (nativeResult !== null && nativeResult.trim().length > 0) {
            return { text: nativeResult, method: 'native' };
        }

        const worthTryingOcr = IMAGE_EXTENSIONS.has(ext) || (ext === PDF_EXTENSION && nativeResult !== null);
        if (worthTryingOcr) {
            const ocrResult = await tryOcrExtraction(filePath);
            if (ocrResult.trim().length > 0) return { text: ocrResult, method: 'ocr' };
        }

        return { text: null, method: 'unsupported' };
    } catch (err) {
        console.error(`Content extraction failed for ${filename}:`, err.message);
        return { text: null, method: 'error' };
    }
}

module.exports = { extractDocumentContent };
