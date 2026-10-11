# Office keyboard and save verification — 2026-10-11

Tested merged PR #51 at `8c59dc5bbda44517912a171bce26ea36f75c60d9`.
Codex used trusted Paseo browser keypress events, one character at a time into
Office's canvas, then Kady Save, Reload project file and another Save.
No document bytes or UNO text commands were injected.

| Format | Marker | Saved and reopened evidence |
| --- | --- | --- |
| Writer DOCX | `kadywriter20261011a7f73974e` | Marker in `word/document.xml` text |
| Calc XLSX | `kadycalc7f73974e` | Exact value in `Measurements!F1`, resolved through shared strings |
| Impress PPTX | `kadyimpress7f73974e` | Marker appended to the title in `ppt/slides/slide1.xml` |

All six packages passed ZIP CRC and XML parsing checks; parent independently
rechecked the files. Markers were absent from original disposable fixtures.
Writer's initial browser text-typing attempt did not persist and is not counted.
The keypress-based attempts passed. Reopened Calc also displayed the marker in F1.

Both services ran from a disposable copy of tracked source with isolated project,
auth and runtime directories. No model calls, user credentials or user documents
were used. Existing app ports were untouched and test processes were stopped.
The local evidence bundle is `kady-office-keyboard-20261011` in the temporary
directory, containing the full report, original and saved packages, XML, hashes
and key-event logs; it is local evidence rather than a permanent repository artifact.

Native computer control failed because its trusted service was unavailable.
Paseo keyboard control succeeded. Screenshots were unavailable, so visual layout,
advanced objects and formatting preservation remain unverified. Browser tab URL
restoration was rejected by automatic approval review because it could touch an
existing app instance; the reused test tab was safely left blank.
