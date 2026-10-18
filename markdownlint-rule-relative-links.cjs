"use strict";

const path = require("path");
const fs = require("fs");

/**
 * Custom markdownlint rule: "relative-links-valid"
 *
 * Ensures every relative link in a Markdown file resolves to an existing local
 * file. This catches broken navigation when a referenced doc is renamed or moved.
 *
 * Only relative paths are checked. Absolute URLs (including mailto:, etc.),
 * in-page anchors (#...), and protocol-relative URLs (//...) are ignored.
 */
module.exports = {
  names: ["relative-links-valid"],
  description: "Inline links to local files must resolve to existing paths",
  tags: ["links"],
  function: (params, onError) => {
    const filePath = params.name || "";
    const baseDir = path.dirname(filePath);
    const lines = params.lines || [];

    const linkRegex = /\]\(\s*([^)\s]*)/g;
    const htmlRegex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["']/gi;
    const refDefRegex = /^[ \t]*\[[^\]]+\]:[ \t]*(\S+)/g;

    let inFence = false;
    let fenceMarker = "";

    lines.forEach((line, lineIndex) => {
      const lineNumber = lineIndex + 1;

      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!inFence) {
          inFence = true;
          fenceMarker = marker;
        } else if (marker[0] === fenceMarker[0]) {
          inFence = false;
          fenceMarker = "";
        }
        return;
      }

      if (inFence) {
        return;
      }

      let m;
      linkRegex.lastIndex = 0;
      while ((m = linkRegex.exec(line)) !== null) {
        checkTarget(m[1], lineNumber, baseDir, onError);
      }
      htmlRegex.lastIndex = 0;
      while ((m = htmlRegex.exec(line)) !== null) {
        checkTarget(m[1], lineNumber, baseDir, onError);
      }
      refDefRegex.lastIndex = 0;
      while ((m = refDefRegex.exec(line)) !== null) {
        checkTarget(m[1], lineNumber, baseDir, onError);
      }
    });
  },
};

function checkTarget(target, lineNumber, baseDir, onError) {
  const t = (target || "").trim();
  if (!t) {
    return;
  }
  // Ignore absolute URLs, scheme-qualified values, and emails (e.g. https:,
  // mailto:, tel:, data:).
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) {
    return;
  }
  // Ignore in-page anchors and protocol-relative URLs.
  if (t.startsWith("#") || t.startsWith("//")) {
    return;
  }
  // Strip any fragment or query before resolving the file path.
  const withoutFragment = t.split("#")[0].split("?")[0];
  if (!withoutFragment) {
    return;
  }
  const resolved = path.resolve(baseDir, withoutFragment);
  let exists = false;
  try {
    exists = fs.existsSync(resolved);
  } catch (err) {
    exists = false;
  }
  if (exists) {
    return;
  }
  onError({
    lineNumber: lineNumber,
    detail:
      'Relative link target does not exist: "' +
      t +
      '" (resolved to "' +
      resolved +
      '").',
  });
}
