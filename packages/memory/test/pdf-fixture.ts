/** Small real PDF with a digital page and a scanned page, including image XObjects. */
export function pdfFixture(jpeg: Buffer, pages = 2) {
  const objects: Buffer[] = [], add = (value: string | Buffer) => objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value))
  const stream = (data: Buffer, header = '') => Buffer.concat([Buffer.from(`<< ${header} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')])
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add(`<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${5 + i * 2} 0 R`).join(' ')}] >>`)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  add(stream(jpeg, '/Type /XObject /Subtype /Image /Width 300 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode'))
  for (let i = 0; i < pages; i++) {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`)
    add(stream(Buffer.from(`${i === 0 ? 'BT /F1 16 Tf 20 260 Td (Aurora budget approved: 750 dollars for local memory.) Tj ET\n' : ''}q 300 0 0 100 20 70 cm /Im1 Do Q`)))
  }
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.concat(chunks).length)
    chunks.push(Buffer.from(`${i + 1} 0 obj\n`), objects[i]!, Buffer.from('\nendobj\n'))
  }
  const xref = Buffer.concat(chunks).length
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`))
  return Buffer.concat(chunks)
}
