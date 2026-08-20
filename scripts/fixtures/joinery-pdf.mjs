/**
 * A two-page technical PDF, generated rather than committed.
 *
 * Page 1 is prose with dimensions in it. Page 2 carries an actual vector
 * drawing — a stop-splayed scarf in elevation, with pegs, dimension lines and
 * a caption — plus a table. The drawing is the point: `ingest-document`'s
 * prompt argues that in technical literature the drawings carry what matters,
 * and a text-only fixture would never test whether that claim survives contact
 * with the model.
 *
 * Nothing here is real. Manor Farm barn and Technical Note 14 are inventions,
 * which is what makes them useful — the model cannot answer from prior
 * knowledge, so a correct extraction proves it read the document.
 */

const esc = s => s.replace(/([\\()])/g, '\\$1');

function textPage(lines) {
  let s = 'BT\n/F1 10 Tf\n12 TL\n50 780 Td\n';
  for (const [style, line] of lines) {
    s += style === 'b' ? '/F2 11 Tf\n' : '/F1 10 Tf\n';
    s += `(${esc(line)}) Tj T*\n`;
  }
  return s + 'ET\n';
}

const PAGE_ONE = textPage([
  ['b', 'Repair of Decayed Beam and Sill Ends in Historic Timber Framing'],
  ['n', 'Technical Note 14, Building Conservation Directorate, 1998'],
  ['n', ''],
  ['b', '1. When a splice is appropriate'],
  ['n', 'Where decay is confined to the bearing end of a member and the remainder of'],
  ['n', 'the timber retains its section and strength, replacement of the whole member'],
  ['n', 'is rarely justified. A spliced repair conserves the historic fabric and the'],
  ['n', 'tool marks upon it. Probe the member at 150mm intervals with a bradawl to'],
  ['n', 'establish the extent of soft material before deciding the cut line.'],
  ['n', 'Set the cut line a minimum of 300mm beyond the last evidence of decay.'],
  ['n', ''],
  ['b', '2. The stop-splayed scarf with under-squinted butts'],
  ['n', 'This is the standard joint for a sill or wall plate carrying axial load.'],
  ['n', 'The splay transmits compression across the join; the squinted butts resist'],
  ['n', 'the tension that arises when the frame racks. Proportions are governed by'],
  ['n', 'the depth of the member:'],
  ['n', ''],
  ['n', '   Total joint length        4.0 to 4.5 x the depth of the timber'],
  ['n', '   Splay length              2.5 x depth'],
  ['n', '   Butt height               one third of depth'],
  ['n', '   Peg diameter              22mm oak, riven not turned'],
  ['n', '   Number of pegs            two, at one quarter points of the splay'],
  ['n', ''],
  ['n', 'For a 140 x 160mm oak sill the joint therefore runs 640 to 720mm overall,'],
  ['n', 'with a splay of 400mm and butts of 53mm.'],
  ['n', ''],
  ['b', '3. Materials and moisture'],
  ['n', 'New timber must match the species of the original: oak to oak, never oak'],
  ['n', 'against softwood, since the tannins and the differential movement will open'],
  ['n', 'the joint within a season. Air-dried stock at 18 to 22 percent moisture'],
  ['n', 'content is correct for an unheated frame. Kiln-dried timber will take up'],
  ['n', 'moisture from the surrounding fabric and swell, splitting at the pegs.'],
  ['n', ''],
  ['b', '4. Draw-boring'],
  ['n', 'Offset the peg hole in the tenon by 3mm toward the shoulder. Driving a'],
  ['n', 'tapered peg then pulls the faces of the joint together permanently and'],
  ['n', 'without cramps. An offset greater than 4mm will shear the peg on driving.'],
  ['n', ''],
  ['b', '5. Where the splice is not appropriate'],
  ['n', 'Do not splice a member whose decay extends past mid-span, nor one carrying'],
  ['n', 'concentrated load at the position of the joint. Where a post foot has'],
  ['n', 'decayed, a scarf is inappropriate and the repair is a lapped and bolted'],
  ['n', 'shoe, described in Technical Note 21.'],
]);

const PAGE_TWO = `
0.8 w
80 600 m 300 600 l S
80 520 m 260 520 l S
80 600 m 80 520 l S
260 520 m 260 547 l S
260 547 m 440 573 l S
440 573 m 440 600 l S
300 600 m 520 600 l S
440 600 m 520 600 l S
260 520 m 520 520 l S
520 600 m 520 520 l S
300 600 m 300 573 l S
300 573 m 440 573 l S
1.2 w
330 566 m 344 566 l S
337 559 m 337 573 l S
400 566 m 414 566 l S
407 559 m 407 573 l S
0.5 w
260 495 m 440 495 l S
260 500 m 260 490 l S
440 500 m 440 490 l S
65 600 m 65 520 l S
60 600 m 70 600 l S
60 520 m 70 520 l S
BT /F1 8 Tf 300 483 Td (splay 400mm = 2.5 x depth) Tj ET
BT /F1 8 Tf 30 556 Td (160) Tj ET
BT /F1 8 Tf 306 606 Td (butt 53mm) Tj ET
BT /F1 8 Tf 322 540 Td (draw-bored oak pegs, 22mm) Tj ET
BT /F2 10 Tf 80 450 Td (Fig. 7  Stop-splayed scarf with under-squinted butts, elevation.) Tj ET
BT /F1 9 Tf 80 434 Td (Sill repair to the south wall, Manor Farm barn. New oak at the left,) Tj ET
BT /F1 9 Tf 80 422 Td (original 1680s oak at the right. Scale 1:10 on the original sheet.) Tj ET
BT /F2 10 Tf 80 380 Td (Table 2  Joint proportions by member depth) Tj ET
BT /F1 9 Tf 80 362 Td (depth 100mm   joint 400-450mm   splay 250mm   butt 33mm   peg 16mm) Tj ET
BT /F1 9 Tf 80 350 Td (depth 140mm   joint 560-630mm   splay 350mm   butt 47mm   peg 19mm) Tj ET
BT /F1 9 Tf 80 338 Td (depth 160mm   joint 640-720mm   splay 400mm   butt 53mm   peg 22mm) Tj ET
BT /F1 9 Tf 80 326 Td (depth 200mm   joint 800-900mm   splay 500mm   butt 67mm   peg 25mm) Tj ET
`;

export function buildFixturePdf() {
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents 4 0 R >>';
  objects[5] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents 6 0 R >>';
  objects[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[8] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  objects[4] = { stream: PAGE_ONE };
  objects[6] = { stream: PAGE_TWO };

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i <= 8; i++) {
    offsets[i] = out.length;
    const o = objects[i];
    if (typeof o === 'object' && o.stream !== undefined) {
      out += `${i} 0 obj\n<< /Length ${o.stream.length} >>\nstream\n${o.stream}\nendstream\nendobj\n`;
    } else {
      out += `${i} 0 obj\n${o}\nendobj\n`;
    }
  }
  const xref = out.length;
  out += 'xref\n0 9\n0000000000 65535 f \n';
  for (let i = 1; i <= 8; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}
