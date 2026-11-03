// PresentationML: slides in presentation order, each with its speaker notes and comments, then
// what masters and layouts add to every slide (footers, logos as text), charts, and the common places.
import type { Pkg } from './package';
import { charts, common, drawingPart, TextBuilder, type Extras, type OfficeText } from './text';
import { attrs, tags } from './xml';

const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** legacy comments (<p:text>) and modern ones (DrawingML text) */
function commentPart(b: TextBuilder, part: string, x: string, ex: Extras) {
  if (/<p:text>/.test(x)) {
    let open = -1;
    for (const t of tags(x)) {
      if (t.name !== 'p:text') continue;
      if (!t.close && !t.self) open = t.end;
      else if (t.close && open >= 0) {
        b.run(part, x, open, t.start);
        b.sep('\n');
        open = -1;
      }
    }
  } else drawingPart(b, part, x, ex);
}

export function pptxText(p: Pkg, main: string, pkg = ''): OfficeText {
  const b = new TextBuilder(pkg);
  const ex: Extras = { fields: [], alt: [] };
  const pres = p.xml(main);
  const rels = new Map(p.rels(main).map((r) => [r.id, r]));
  const slides: string[] = [];
  for (const t of tags(pres)) {
    if (t.name !== 'p:sldId' || t.close) continue;
    const rid = attrs(pres, t).find((a) => a.name === 'r:id')?.raw;
    const r = rid ? rels.get(rid) : undefined;
    if (r && !r.external && p.has(r.part)) slides.push(r.part);
  }
  // slides not listed (hidden from the order) are still in the file
  for (const n of p.names().filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x)).sort(natural)) if (!slides.includes(n)) slides.push(n);
  slides.forEach((slide, i) => {
    b.section(`Slide ${i + 1}`, (s) => drawingPart(s, slide, p.xml(slide), ex));
    for (const r of p.rels(slide)) {
      if (r.external || !p.has(r.part)) continue;
      if (r.type.endsWith('/notesSlide')) b.section(`Slide ${i + 1} notes`, (s) => drawingPart(s, r.part, p.xml(r.part), ex));
      else if (/\/comments$/.test(r.type)) b.section(`Slide ${i + 1} comments`, (s) => commentPart(s, r.part, p.xml(r.part), ex));
    }
  });
  b.section('Masters and layouts', (s) => {
    for (const n of p.names().filter((x) => /^ppt\/(?:slideMasters|slideLayouts|notesMasters|handoutMasters)\/\w+\.xml$/.test(x)).sort(natural)) drawingPart(s, n, p.xml(n), ex, true);
  });
  charts(b, p, 'ppt/', ex);
  // section names of the presentation
  b.section('Sections', (s) => {
    for (const t of tags(pres)) {
      if (t.name !== 'p14:section' || t.close) continue;
      const a = attrs(pres, t).find((x) => x.name === 'name');
      if (a) {
        s.run(main, pres, a.start, a.end, { kind: 'attr' });
        s.sep('\n');
      }
    }
  });
  common(b, p, ex);
  return b.done();
}
