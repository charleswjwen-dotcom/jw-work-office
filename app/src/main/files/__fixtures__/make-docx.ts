import JSZip from 'jszip'

// 测试夹具：生成最小合法 .docx（OOXML zip）。
// 为什么自己造而不放二进制夹具文件：
// - 保持仓库纯文本、可 diff、可复现（不引入 binary blob）；
// - 精确控制"复杂度"维度（段落数 / 标题 / 特殊字符），让集成测试可断言字数与检索命中。
// 结构遵循 ECMA-376：[Content_Types].xml + _rels + word/document.xml。

function paragraphXml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<w:p><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`
}

export async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip()

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  )

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  )

  const body = paragraphs.map(paragraphXml).join('')
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr/></w:body>
</w:document>`
  )

  return zip.generateAsync({ type: 'nodebuffer' })
}
