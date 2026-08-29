#!/usr/bin/env python3
"""
Stage 3: the human ear.

Serves a local review page at http://127.0.0.1:8787 with one screened track
per screen: play it, see exactly where the detector heard an instrument, and
press a key to accept or reject. Decisions are written to
tools/work/decisions.json after every single keystroke, so closing the tab
never loses work.

This stage exists because the two questions that matter cannot be answered by
a machine:

  1. Is that drum a duff, or a drum kit? AudioSet has no duff class, so
     screen.py routes every percussive track here rather than guessing.

  2. Do the lyrics say something impermissible? No classifier is going to
     tell you that a beautifully-sung line is praising the wrong thing.

Keyboard, because a mouse makes a hundred decisions feel like a hundred
decisions:

    A / 1   accept — voice only
    S / 2   accept — voice + duff
    D / 3   accept — duff only
    R       reject
    L       reject — licence looks wrong (uploader is not the rights holder)
    U       unsure, come back to it
    Space   play / pause
    J / K   previous / next

Usage:
    python3 tools/review.py
    python3 tools/review.py --port 9000
"""

from __future__ import annotations

import argparse
import json
import mimetypes
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

WORK = Path(__file__).parent / "work"
AUDIO = WORK / "audio"
SCREENED = WORK / "screened.json"
DECISIONS = WORK / "decisions.json"


def load_screened() -> list[dict[str, Any]]:
    """
    Every successfully screened track, best candidates first.

    An earlier version dropped everything the detector called `has_melodic`,
    on the reasoning that a reviewer's time should go to uncertain cases. That
    was wrong, and the first real run showed why: tuned loosely, the detector
    passed a track with piano in its own top labels; tuned tightly enough to
    catch that, it rejected a genuine unaccompanied vocal nasheed. At no
    setting was it good enough to be the last word.

    So the detector RANKS rather than GATES. Nothing is hidden from the
    reviewer; the cleanest candidates simply come first, and flagged ones
    arrive with the evidence attached. A wrong guess now costs a keystroke
    instead of silently losing a good track from the catalog forever.
    """
    if not SCREENED.exists():
        return []
    rows = [r for r in json.loads(SCREENED.read_text()) if r.get("status") == "screened"]

    # Recompute the extremist-content markers HERE, on every load, rather than
    # trusting whatever screen.py stored.
    #
    # This is not belt-and-braces, it is a real bug that already happened: the
    # marker check was added to screen.py after some rows had been screened, so
    # a track literally titled "Anasheed Alshabaab" sat in the queue with no
    # flag on it at all. A safety check frozen at write time silently stops
    # protecting every row written before the check existed — and the marker
    # list is exactly the kind of thing that keeps growing.
    for row in rows:
        row["extremism_flags"] = extremism_flags(row)

    rows.sort(key=lambda r: -float(r.get("clean_score") or 0))
    return rows


# Kept in sync with tools/screen.py. Duplicated deliberately rather than
# imported: importing screen.py pulls in TensorFlow, which would make the
# review server take half a minute to start and require the ML venv just to
# listen to audio.
EXTREMIST_MARKERS = [
    "أسود الله", "دولة الإسلام", "صليل الصوارم", "جهاد", "استشهاد", "مجاهد",
    "قاعدة", "داعش", "كتائب", "غزوة", "شهداء",
    "lions of", "islamic state", "clashing of the swords", "clanging of the swords",
    "jihad", "mujahid", "mujahideen", "martyrdom", "caliphate", "khilafah",
    "al-qaeda", "isis", "taliban", "shabaab", "ansar", "battalion", "raid on",
]


def extremism_flags(candidate: dict[str, Any]) -> list[str]:
    haystack = " ".join(
        str(candidate.get(f) or "") for f in ("title", "artist", "description", "uploader")
    ).lower()
    return [m for m in EXTREMIST_MARKERS if m.lower() in haystack]


def load_decisions() -> dict[str, dict[str, Any]]:
    if DECISIONS.exists():
        return json.loads(DECISIONS.read_text())
    return {}


def save_decisions(decisions: dict[str, dict[str, Any]]) -> None:
    DECISIONS.write_text(json.dumps(decisions, indent=1, ensure_ascii=False))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: Any) -> None:  # noqa: D102
        pass

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path

        if path == "/":
            return self._send(200, "text/html; charset=utf-8", PAGE.encode())

        if path == "/data":
            tracks = load_screened()
            decisions = load_decisions()
            payload = {"tracks": tracks, "decisions": decisions}
            return self._send(200, "application/json", json.dumps(payload, ensure_ascii=False).encode())

        if path.startswith("/audio/"):
            name = Path(path[len("/audio/") :]).name
            file = AUDIO / name
            if not file.exists():
                return self._send(404, "text/plain", b"not found")
            data = file.read_bytes()
            # Guess by content since the cache stores everything as `.src`.
            mime = mimetypes.guess_type(name)[0] or "audio/mpeg"
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Accept-Ranges", "none")
            self.end_headers()
            self.wfile.write(data)
            return None

        return self._send(404, "text/plain", b"not found")

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/decide":
            return self._send(404, "text/plain", b"not found")
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        decisions = load_decisions()
        decisions[body["key"]] = {
            "verdict": body["verdict"],
            "instrumentation": body.get("instrumentation"),
            "note": body.get("note", ""),
            "decided_at": body.get("decided_at"),
        }
        save_decisions(decisions)
        return self._send(200, "application/json", json.dumps({"ok": True, "count": len(decisions)}).encode())

    def _send(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


PAGE = r"""<!doctype html>
<meta charset="utf-8">
<title>Nasheed review</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 -apple-system,system-ui,sans-serif; background:#0d1117; color:#e6edf3; }
  header { padding:12px 20px; border-bottom:1px solid #21262d; display:flex; gap:20px; align-items:center;
           position:sticky; top:0; background:#0d1117; z-index:5; flex-wrap:wrap; }
  .prog { font-variant-numeric:tabular-nums; color:#8b949e; }
  .bar { height:6px; background:#21262d; border-radius:3px; flex:1; min-width:120px; overflow:hidden; }
  .bar i { display:block; height:100%; background:#2f81f7; }
  main { max-width:860px; margin:0 auto; padding:24px 20px 120px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .meta { color:#8b949e; font-size:13px; margin-bottom:16px; }
  .meta a { color:#58a6ff; }
  audio { width:100%; margin:12px 0; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:16px 0; }
  .box { background:#161b22; border:1px solid #21262d; border-radius:8px; padding:10px 12px; }
  .box b { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#8b949e; margin-bottom:3px; }
  .warn { border-color:#9e6a03; background:#2d2205; }
  .bad  { border-color:#f85149; background:#2d0f0f; }
  .ok   { border-color:#238636; background:#0d2818; }
  .seg { display:inline-block; background:#30363d; border-radius:4px; padding:2px 7px; margin:2px 3px 2px 0;
         font-size:12px; cursor:pointer; font-variant-numeric:tabular-nums; }
  .seg:hover { background:#484f58; }
  .labels { font-size:12px; color:#8b949e; line-height:1.9; }
  .labels span { background:#21262d; border-radius:4px; padding:2px 7px; margin-right:4px; }
  footer { position:fixed; bottom:0; left:0; right:0; background:#161b22; border-top:1px solid #21262d;
           padding:10px 20px; display:flex; gap:8px; flex-wrap:wrap; justify-content:center; }
  button { font:inherit; padding:8px 14px; border-radius:6px; border:1px solid #30363d; background:#21262d;
           color:#e6edf3; cursor:pointer; }
  button:hover { background:#30363d; }
  button kbd { opacity:.6; font-size:11px; margin-left:5px; }
  .b-ok { border-color:#238636; } .b-bad { border-color:#f85149; } .b-idk { border-color:#9e6a03; }
  .done { color:#3fb950; font-weight:600; }
  .empty { text-align:center; padding:80px 20px; color:#8b949e; }
</style>
<header>
  <strong>Nasheed review</strong>
  <span class="prog" id="prog">—</span>
  <span class="bar"><i id="fill" style="width:0"></i></span>
  <span class="prog" id="tally"></span>
</header>
<main id="main"><div class="empty">Loading…</div></main>
<footer>
  <button class="b-ok" onclick="decide('accept','voice_only')">Voice only<kbd>A</kbd></button>
  <button class="b-ok" onclick="decide('accept','voice_duff')">Voice + duff<kbd>S</kbd></button>
  <button class="b-ok" onclick="decide('accept','duff_only')">Duff only<kbd>D</kbd></button>
  <button class="b-bad" onclick="decide('reject',null)">Reject<kbd>R</kbd></button>
  <button class="b-bad" onclick="decide('reject_license',null)">Bad licence<kbd>L</kbd></button>
  <button class="b-idk" onclick="decide('unsure',null)">Unsure<kbd>U</kbd></button>
  <button onclick="move(-1)">Prev<kbd>J</kbd></button>
  <button onclick="move(1)">Next<kbd>K</kbd></button>
</header>
<script>
let tracks = [], decisions = {}, i = 0;

async function load() {
  const r = await fetch('/data');
  const d = await r.json();
  tracks = d.tracks; decisions = d.decisions || {};
  // Start at the first undecided track so a resumed session picks up where
  // it stopped rather than replaying everything already judged.
  const next = tracks.findIndex(t => !decisions[t.key]);
  i = next === -1 ? 0 : next;
  render();
}

function fmt(s) {
  if (s == null) return '—';
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

function render() {
  const main = document.getElementById('main');
  if (!tracks.length) {
    main.innerHTML = '<div class="empty">No screened tracks yet.<br>Run <code>tools/screen.py</code> first.</div>';
    return;
  }
  const t = tracks[i];
  const dec = decisions[t.key];
  const perc = t.needs_human_percussion_check;

  document.getElementById('prog').textContent = (i + 1) + ' / ' + tracks.length;
  document.getElementById('fill').style.width = ((i + 1) / tracks.length * 100) + '%';
  const counts = Object.values(decisions).reduce((a, d) => (a[d.verdict] = (a[d.verdict] || 0) + 1, a), {});
  document.getElementById('tally').textContent =
    (counts.accept || 0) + ' accepted · ' + (counts.reject || 0) + ' rejected · ' + (counts.unsure || 0) + ' unsure';

  main.innerHTML = `
    <h1>${esc(t.title)}</h1>
    <div class="meta">
      ${esc(t.artist || 'unknown artist')} ·
      <b>${esc(t.license)}</b> ·
      ${esc((t.source_platform || '').split(':')[0])} ·
      <a href="${esc(t.source_url)}" target="_blank" rel="noopener">source ↗</a>
      ${t.uploader ? ' · uploaded by ' + esc(t.uploader) : ''}
      ${dec ? '<br><span class="done">already decided: ' + esc(dec.verdict) + (dec.instrumentation ? ' (' + esc(dec.instrumentation) + ')' : '') + '</span>' : ''}
    </div>

    ${t.uploader && t.artist && !String(t.uploader).toLowerCase().includes(String(t.artist).toLowerCase().split(' ')[0] || 'zzz')
      ? '<div class="box warn"><b>Licence check</b>The uploader and the credited artist look different. On public archives that usually means somebody re-uploaded a commercial recording and ticked a Creative Commons box they had no right to tick. Verify before accepting.</div>'
      : ''}

    ${(t.extremism_flags || []).length ? `<div class="box bad">
      <b>Stop — get the lyrics translated before you accept this</b>
      This track's metadata contains phrases conventionally used in jihadi nasheeds:
      <b style="display:inline;text-transform:none;letter-spacing:0;color:#f85149">${t.extremism_flags.map(esc).join(', ')}</b>.
      <div style="margin-top:8px;font-size:12px;color:#8b949e">
        That genre is almost entirely unaccompanied vocal, so it passes every instrumentation
        check looking exactly like what this catalog wants. These words also appear innocently in
        classical poetry — this is a reason to check, not a verdict. If you cannot read the lyrics,
        reject it. An unverified accept here is far more costly than a wrongly rejected track.
      </div>
      </div>` : ''}

    <audio id="player" controls src="/audio/${esc(t.local_audio || '')}"></audio>

    <div class="grid">
      <div class="box ${t.melodic_ratio > 0.02 ? 'warn' : 'ok'}">
        <b>Melodic instrument</b>${(t.melodic_ratio * 100).toFixed(1)}% of frames
      </div>
      <div class="box ${perc ? 'warn' : 'ok'}">
        <b>Percussion</b>${(t.percussion_ratio * 100).toFixed(1)}% of frames
      </div>
      <div class="box"><b>Voice</b>${(t.voice_ratio * 100).toFixed(1)}% of frames</div>
      <div class="box"><b>Length</b>${fmt(t.duration_seconds)}</div>
      <div class="box"><b>Loudness</b>${t.loudness_lufs != null ? t.loudness_lufs.toFixed(1) + ' LUFS' : '—'}</div>
      <div class="box"><b>Detector says</b>${esc(t.instrumentation_guess)}</div>
      <div class="box"><b>Clean score</b>${(t.clean_score ?? 0).toFixed(2)}</div>
    </div>

    ${perc ? '<div class="box warn"><b>Listen for this</b>AudioSet has no class for the duff, so a frame drum and a drum kit look identical to the detector. Percussion was heard here — decide by ear whether it is a duff.</div>' : ''}

    ${(t.melodic_reasons || []).length ? `<div class="box bad"><b>Detector flagged a melodic instrument because</b>
      <ul style="margin:4px 0 0 16px;padding:0;font-size:13px">
        ${t.melodic_reasons.map(r => '<li>' + esc(r) + '</li>').join('')}
      </ul>
      <div style="margin-top:8px;font-size:12px;color:#8b949e">
        The detector is wrong often enough in both directions that it does not get the last word.
        Reverb and layered vocals can read as an organ; a quiet oud can read as nothing. Judge by ear.
      </div>
      </div>` : ''}

    ${(t.melodic_warnings || []).length ? `<div class="box warn"><b>Worth a careful listen</b>
      <ul style="margin:4px 0 0 16px;padding:0;font-size:13px">
        ${t.melodic_warnings.map(r => '<li>' + esc(r) + '</li>').join('')}
      </ul>
      <div style="margin-top:8px;font-size:12px;color:#8b949e">
        Not enough to disqualify on the numbers, but enough that the detector noticed something.
      </div>
      </div>` : ''}

    ${(t.melodic_segments || []).length ? `<div class="box bad"><b>Detector heard an instrument at</b>
      ${t.melodic_segments.map(s => `<span class="seg" onclick="seek(${s[0]})">${fmt(s[0])}–${fmt(s[1])}</span>`).join('')}
      </div>` : ''}

    ${(t.percussion_segments || []).length ? `<div class="box"><b>Percussion at</b>
      ${t.percussion_segments.map(s => `<span class="seg" onclick="seek(${s[0]})">${fmt(s[0])}</span>`).join('')}
      </div>` : ''}

    <div class="box"><b>Top AudioSet labels</b>
      <div class="labels">${(t.top_labels || []).map(l => `<span>${esc(l[0])} ${l[1]}</span>`).join('')}</div>
    </div>
  `;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function seek(sec) { const p = document.getElementById('player'); if (p) { p.currentTime = sec; p.play(); } }
function move(d) { i = Math.max(0, Math.min(tracks.length - 1, i + d)); render(); window.scrollTo(0, 0); }

async function decide(verdict, instrumentation) {
  const t = tracks[i];
  if (!t) return;
  decisions[t.key] = { verdict, instrumentation, decided_at: new Date().toISOString() };
  await fetch('/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: t.key, verdict, instrumentation, decided_at: new Date().toISOString() })
  });
  move(1);
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const map = {
    a: () => decide('accept','voice_only'),  '1': () => decide('accept','voice_only'),
    s: () => decide('accept','voice_duff'),  '2': () => decide('accept','voice_duff'),
    d: () => decide('accept','duff_only'),   '3': () => decide('accept','duff_only'),
    r: () => decide('reject', null),
    l: () => decide('reject_license', null),
    u: () => decide('unsure', null),
    j: () => move(-1), k: () => move(1),
  };
  const key = e.key.toLowerCase();
  if (key === ' ') {
    e.preventDefault();
    const p = document.getElementById('player');
    if (p) { p.paused ? p.play() : p.pause(); }
    return;
  }
  if (map[key]) { e.preventDefault(); map[key](); }
});

load();
</script>
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    tracks = load_screened()
    decided = load_decisions()
    print(f"{len(tracks)} tracks to review, {len(decided)} already decided")
    print(f"\n  open  http://127.0.0.1:{args.port}\n")
    print("  A voice only   S voice+duff   D duff only   R reject   L bad licence   U unsure")
    print("  Space play/pause   J prev   K next\n")
    print("Ctrl-C when done, then: python3 tools/publish.py")

    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
