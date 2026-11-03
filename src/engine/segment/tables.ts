// Tables read from Office files and PDFs are written out as Markdown under a header of column
// letters (| A | B |): whether their first row is a header is decided here, by the Markdown
// segmenter, the same way for every source. Pure.

/** a word of a header cell: letters, letters with a short number (Q1, IPv4, SHA256, 2FA), or a short number */
const LABEL_WORD = /^(?:\p{L}+\d{0,3}|\d{1,3}\p{L}+|\d{1,2})$/u;

/**
 * A first row that reads as column headers (short labels, no values). A first row holding values
 * ("Password | x!9Lm2", numbers, dates, emails, J3nkins) is data: the table gets letters as its header.
 */
export function headerLike(cells: string[]): boolean {
  const filled = cells.map((c) => c.trim()).filter(Boolean);
  return (
    filled.length > 0 &&
    filled.every(
      (c) =>
        c.length <= 40 &&
        !/[@!$%^&*=<>{}|\\]/.test(c) &&
        !/^[-+]?\d[\d\s.,:/-]*$/.test(c) &&
        c
          .split(/[\s/(),.:;#&+'"-]+/)
          .filter(Boolean)
          .every((w) => !/\d/.test(w) || LABEL_WORD.test(w)),
    )
  );
}

/** column letters A, B, … Z, AA, AB … */
export const letters = (n: number) => [...Array(n).keys()].map((i) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26)));
