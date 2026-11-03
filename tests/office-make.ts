// Small Office files for tests and metrics, written by hand (no realistic secrets: values come in).
import { zipSync } from 'fflate';

const enc = new TextEncoder();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const zip = (files: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v])));

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** a paragraph; text in several runs when given an array (a value can be split across runs) */
export const para = (text: string | string[]) => `<w:p>${(Array.isArray(text) ? text : [text]).map((t) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`).join('')}</w:p>`;
export const table = (rows: string[][]) => `<w:tbl><w:tblPr/>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr/>${para(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;

export interface DocxOpts {
  body: string;
  /** a 1×1 PNG or a real picture */
  image?: Uint8Array;
  imageAlt?: string;
  header?: string;
  comment?: { author: string; text: string };
  link?: string;
  core?: { creator: string; title: string };
  company?: string;
  custom?: [string, string];
  thumbnail?: boolean;
}

/** a DOCX with the parts that matter for redaction */
export function makeDocx(o: DocxOpts): Uint8Array {
  const rels: string[] = [];
  const overrides: string[] = ['<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'];
  const files: Record<string, string | Uint8Array> = {};
  const rootRels = [`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>`];
  let body = o.body;
  if (o.image) {
    rels.push(`<Relationship Id="rIdImg" Type="${REL}/image" Target="media/image1.png"/>`);
    files['word/media/image1.png'] = o.image;
    body += `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Picture 1" descr="${esc(o.imageAlt ?? '')}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  }
  if (o.link) {
    rels.push(`<Relationship Id="rIdLink" Type="${REL}/hyperlink" Target="${esc(o.link)}" TargetMode="External"/>`);
    body += `<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>the runbook</w:t></w:r></w:hyperlink></w:p>`;
  }
  let sect = '';
  if (o.header) {
    rels.push(`<Relationship Id="rIdHdr" Type="${REL}/header" Target="header1.xml"/>`);
    overrides.push('<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>');
    files['word/header1.xml'] = `${HEAD}<w:hdr ${W}>${para(o.header)}</w:hdr>`;
    sect = '<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/></w:sectPr>';
  }
  if (o.comment) {
    rels.push(`<Relationship Id="rIdCmt" Type="${REL}/comments" Target="comments.xml"/>`);
    rels.push(`<Relationship Id="rIdPpl" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/>`);
    overrides.push('<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>');
    overrides.push('<Override PartName="/word/people.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml"/>');
    files['word/comments.xml'] = `${HEAD}<w:comments ${W}><w:comment w:id="0" w:author="${esc(o.comment.author)}" w:date="2024-01-01T00:00:00Z" w:initials="JE">${para(o.comment.text)}</w:comment></w:comments>`;
    files['word/people.xml'] = `${HEAD}<w15:people ${W}><w15:person w15:author="${esc(o.comment.author)}"><w15:presenceInfo w15:providerId="AD" w15:userId="S::someone@example.org::1"/></w15:person></w15:people>`;
    body = body.replace('<w:p>', '<w:p><w:commentRangeStart w:id="0"/>').replace('</w:p>', '<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>');
  }
  if (o.core) {
    rootRels.push(`<Relationship Id="rId2" Type="${PKG_REL}/metadata/core-properties" Target="docProps/core.xml"/>`);
    overrides.push('<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>');
    files['docProps/core.xml'] = `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(o.core.title)}</dc:title><dc:creator>${esc(o.core.creator)}</dc:creator><cp:lastModifiedBy>${esc(o.core.creator)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2024-01-01T00:00:00Z</dcterms:created></cp:coreProperties>`;
  }
  if (o.company) {
    rootRels.push(`<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>`);
    overrides.push('<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>');
    files['docProps/app.xml'] = `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Office Word</Application><Company>${esc(o.company)}</Company><Pages>1</Pages></Properties>`;
  }
  if (o.custom) {
    rootRels.push(`<Relationship Id="rId4" Type="${REL}/custom-properties" Target="docProps/custom.xml"/>`);
    overrides.push('<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>');
    files['docProps/custom.xml'] = `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="${esc(o.custom[0])}"><vt:lpwstr>${esc(o.custom[1])}</vt:lpwstr></property></Properties>`;
  }
  if (o.thumbnail) {
    rootRels.push(`<Relationship Id="rId5" Type="${PKG_REL}/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/>`);
    files['docProps/thumbnail.jpeg'] = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  }
  files['[Content_Types].xml'] = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>${overrides.join('')}</Types>`;
  files['_rels/.rels'] = `${HEAD}<Relationships xmlns="${PKG_REL}">${rootRels.join('')}</Relationships>`;
  files['word/_rels/document.xml.rels'] = `${HEAD}<Relationships xmlns="${PKG_REL}">${rels.join('')}</Relationships>`;
  files['word/document.xml'] = `${HEAD}<w:document ${W}><w:body>${body}${sect}</w:body></w:document>`;
  return zip(files);
}

/** a paragraph with an insertion and a deletion (tracked changes) */
export const tracked = (inserted: string, deleted: string, author: string) =>
  `<w:p><w:r><w:t xml:space="preserve">Status: </w:t></w:r><w:ins w:id="11" w:author="${esc(author)}" w:date="2024-01-02T00:00:00Z"><w:r><w:t>${esc(inserted)}</w:t></w:r></w:ins><w:del w:id="12" w:author="${esc(author)}" w:date="2024-01-02T00:00:00Z"><w:r><w:delText>${esc(deleted)}</w:delText></w:r></w:del></w:p>`;

/** a HYPERLINK field whose instruction is split over two runs */
export const field = (url: string) =>
  `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "${esc(url.slice(0, 12))}</w:instrText></w:r><w:r><w:instrText xml:space="preserve">${esc(url.slice(12))}" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>portal</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const shape = (id: number, lines: string[][], ph = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${lines.map((runs) => `<a:p>${runs.map((t) => `<a:r><a:rPr lang="en-US"/><a:t>${esc(t)}</a:t></a:r>`).join('')}</a:p>`).join('')}</p:txBody></p:sp>`;

/** a PPTX: one slide per entry (paragraphs of runs), optional speaker notes and a comment */
export function makePptx(slides: { lines: string[][]; notes?: string; comment?: { author: string; text: string } }[], layoutFooter = 'Footer text'): Uint8Array {
  const files: Record<string, string | Uint8Array> = {};
  const ov: string[] = ['<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>', '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>', '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'];
  const presRels = [`<Relationship Id="rIdM" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`];
  const ids: string[] = [];
  let authors = false;
  slides.forEach((sl, i) => {
    const n = i + 1;
    presRels.push(`<Relationship Id="rIdS${n}" Type="${REL}/slide" Target="slides/slide${n}.xml"/>`);
    ids.push(`<p:sldId id="${255 + n}" r:id="rIdS${n}"/>`);
    ov.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    files[`ppt/slides/slide${n}.xml`] = `${HEAD}<p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shape(2, sl.lines)}</p:spTree></p:cSld></p:sld>`;
    const rels = [`<Relationship Id="rIdL" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`];
    if (sl.notes) {
      rels.push(`<Relationship Id="rIdN" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`);
      ov.push(`<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`);
      files[`ppt/notesSlides/notesSlide${n}.xml`] = `${HEAD}<p:notes ${P}><p:cSld><p:spTree>${shape(3, [[sl.notes]], '<p:ph type="body" idx="1"/>')}</p:spTree></p:cSld></p:notes>`;
    }
    if (sl.comment) {
      authors = true;
      rels.push(`<Relationship Id="rIdC" Type="${REL}/comments" Target="../comments/comment${n}.xml"/>`);
      ov.push(`<Override PartName="/ppt/comments/comment${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.comments+xml"/>`);
      files[`ppt/comments/comment${n}.xml`] = `${HEAD}<p:cmLst ${P}><p:cm authorId="0" dt="2024-01-01T00:00:00.000" idx="1"><p:pos x="10" y="10"/><p:text>${esc(sl.comment.text)}</p:text></p:cm></p:cmLst>`;
      files['ppt/commentAuthors.xml'] = `${HEAD}<p:cmAuthorLst ${P}><p:cmAuthor id="0" name="${esc(sl.comment.author)}" initials="JE" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`;
    }
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = `${HEAD}<Relationships xmlns="${PKG_REL}">${rels.join('')}</Relationships>`;
  });
  if (authors) {
    presRels.push(`<Relationship Id="rIdA" Type="${REL}/commentAuthors" Target="commentAuthors.xml"/>`);
    ov.push('<Override PartName="/ppt/commentAuthors.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml"/>');
  }
  files['ppt/slideLayouts/slideLayout1.xml'] = `${HEAD}<p:sldLayout ${P}><p:cSld><p:spTree>${shape(2, [['Click to edit Master title style']], '<p:ph type="title"/>')}${shape(3, [[layoutFooter]], '<p:ph type="ftr" sz="quarter" idx="11"/>')}</p:spTree></p:cSld></p:sldLayout>`;
  files['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = `${HEAD}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
  files['ppt/slideMasters/slideMaster1.xml'] = `${HEAD}<p:sldMaster ${P}><p:cSld><p:spTree>${shape(2, [['Click to edit Master text styles']], '<p:ph type="body" idx="1"/>')}</p:spTree></p:cSld><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
  files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = `${HEAD}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`;
  files['ppt/presentation.xml'] = `${HEAD}<p:presentation ${P}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst><p:sldIdLst>${ids.join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  files['ppt/_rels/presentation.xml.rels'] = `${HEAD}<Relationships xmlns="${PKG_REL}">${presRels.join('')}</Relationships>`;
  files['[Content_Types].xml'] = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${ov.join('')}</Types>`;
  files['_rels/.rels'] = `${HEAD}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
  return zip(files);
}

/** an XLSX: one sheet per entry; strings go to the shared strings (once), numbers stay numbers; dates in a date-formatted column */
export function makeXlsx(sheets: { name: string; rows: (string | number | { date: number } | { formula: string; value: string })[][] }[], comment?: { author: string; text: string }): Uint8Array {
  const files: Record<string, string | Uint8Array> = {};
  const sst: string[] = [];
  const si = (s: string) => {
    let i = sst.indexOf(s);
    if (i < 0) i = sst.push(s) - 1;
    return i;
  };
  const col = (i: number) => String.fromCharCode(65 + i);
  const ov: string[] = ['<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>', '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>', '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'];
  const wbRels = [`<Relationship Id="rIdSST" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`, `<Relationship Id="rIdSt" Type="${REL}/styles" Target="styles.xml"/>`];
  const sheetEls: string[] = [];
  sheets.forEach((sh, k) => {
    const n = k + 1;
    const rows = sh.rows
      .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
        const ref = `${col(ci)}${ri + 1}`;
        if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
        if (typeof v === 'object' && 'date' in v) return `<c r="${ref}" s="1"><v>${v.date}</v></c>`;
        if (typeof v === 'object') return `<c r="${ref}" t="str"><f>${esc(v.formula)}</f><v>${esc(v.value)}</v></c>`;
        return `<c r="${ref}" t="s"><v>${si(v)}</v></c>`;
      }).join('')}</row>`)
      .join('');
    files[`xl/worksheets/sheet${n}.xml`] = `${HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheetData>${rows}</sheetData><headerFooter><oddHeader>&amp;CConfidential</oddHeader></headerFooter></worksheet>`;
    ov.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    wbRels.push(`<Relationship Id="rIdW${n}" Type="${REL}/worksheet" Target="worksheets/sheet${n}.xml"/>`);
    sheetEls.push(`<sheet name="${esc(sh.name)}" sheetId="${n}" r:id="rIdW${n}"/>`);
    if (comment && n === 1) {
      files['xl/worksheets/_rels/sheet1.xml.rels'] = `${HEAD}<Relationships xmlns="${PKG_REL}"><Relationship Id="rIdCm" Type="${REL}/comments" Target="../comments1.xml"/></Relationships>`;
      ov.push('<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>');
      files['xl/comments1.xml'] = `${HEAD}<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>${esc(comment.author)}</author></authors><commentList><comment ref="A1" authorId="0"><text><r><t xml:space="preserve">${esc(comment.text)}</t></r></text></comment></commentList></comments>`;
    }
  });
  files['xl/sharedStrings.xml'] = `${HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`;
  files['xl/styles.xml'] = `${HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;
  files['xl/workbook.xml'] = `${HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${sheetEls.join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `${HEAD}<Relationships xmlns="${PKG_REL}">${wbRels.join('')}</Relationships>`;
  files['[Content_Types].xml'] = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${ov.join('')}</Types>`;
  files['_rels/.rels'] = `${HEAD}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  return zip(files);
}
