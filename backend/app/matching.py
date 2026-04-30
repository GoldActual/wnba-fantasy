"""Cross-source player name matching.

Different sources spell names differently:
  Rotowire:  "A''ja Wilson"  (doubled apostrophe)
  WNBA.com:  "A'ja Wilson"
  ESPN:      "A'ja Wilson"

Normalize aggressively for matching, but keep the WNBA.com display name
as the canonical form when building player records.
"""
from __future__ import annotations

import re
import unicodedata


_PUNCT_RE = re.compile(r"[^\w\s]")
_WS_RE = re.compile(r"\s+")
_SUFFIX_RE = re.compile(r"\b(jr|sr|ii|iii|iv)\b\.?", re.IGNORECASE)


def normalize_name(name: str) -> str:
    """Lowercase, strip accents, drop punctuation, collapse whitespace, drop suffixes."""
    if not name:
        return ""
    # Strip diacritics: "Núñez" -> "Nunez"
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_name = "".join(c for c in nfkd if not unicodedata.combining(c))
    s = ascii_name.lower()
    s = _SUFFIX_RE.sub("", s)
    s = _PUNCT_RE.sub("", s)
    s = _WS_RE.sub(" ", s).strip()
    return s
