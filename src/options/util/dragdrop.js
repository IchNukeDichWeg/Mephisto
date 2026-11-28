// DROP A PGN ANYWHERE ON THE PAGE -- a button and a paste box are two steps for what should be one.
// One helper for both pages that take a PGN (Analysis and Game Review), so the two cannot drift:
// the whole section is the target (aiming at the one textarea is fiddly), the box lights up so the
// drop has somewhere visible to land, and a drag WITHOUT files -- a text selection, an image dragged
// off the page -- falls through untouched. A file that is not .pgn/.txt/text is ignored.
export function wirePgnDrop(zone, highlightEl, onText) {
    if (!zone) return;
    const hasFile = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    zone.addEventListener('dragover', (e) => {
        if (!hasFile(e)) return;
        e.preventDefault();
        highlightEl?.classList.add('drop-ready');
    });
    zone.addEventListener('dragleave', () => highlightEl?.classList.remove('drop-ready'));
    zone.addEventListener('drop', async (e) => {
        if (!hasFile(e)) return;
        e.preventDefault();
        highlightEl?.classList.remove('drop-ready');
        // Only a PGN-looking file is read. Taking ANY file as a fallback read a polyglot .bin dropped
        // on Analysis (its Load book button sits inside the same zone) into the PGN box as mojibake,
        // replacing the user's game. The drop is still swallowed so the browser does not open the file.
        const f = [...e.dataTransfer.files].find(x => /\.(pgn|txt)$/i.test(x.name) || x.type.startsWith('text/'));
        if (!f) return;
        let text;
        try { text = await f.text(); } catch (err) {   // unreadable (a folder, a revoked file): drop nothing
            console.warn('PGN drop: could not read', f.name, err);
            return;
        }
        onText(text);
    });
}
