import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { makeDocx } from './__fixtures__/make-docx'
import { convertWordToHtml, parseWordFile } from './word-parser'

// T-S2-08 预览轨单测：convertWordToHtml 的"忠实转换 + 错误语义"，与
// parseWordFile（抽取轨）同源同约定（架构 §3.4 双轨）。转换保真是右栏
// diff 覆盖层按文本匹配的前提——预览 HTML 的文本必须与抽取轨正文一致。

let workDir: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mwo-word-parser-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

async function writeDoc(paragraphs: string[]): Promise<string> {
  const path = join(workDir, `doc-${Math.random().toString(36).slice(2)}.docx`)
  writeFileSync(path, await makeDocx(paragraphs))
  return path
}

// 构造带字符属性的 docx（加粗 run）：验证 mammoth 行内强调的转换保真。
async function writeBoldDoc(): Promise<string> {
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
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>普通正文</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>加粗文字</w:t></w:r></w:p>
<w:sectPr/>
</w:body>
</w:document>`
  )
  const path = join(workDir, `bold-${Math.random().toString(36).slice(2)}.docx`)
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))
  return path
}

describe('convertWordToHtml（mammoth HTML 预览轨）', () => {
  it('纯文本段落转换为 <p> 序列，与抽取轨正文同源', async () => {
    const path = await writeDoc(['第一段正文', '第二段正文'])
    const html = await convertWordToHtml(path)
    expect(html).toContain('<p>第一段正文</p>')
    expect(html).toContain('<p>第二段正文</p>')

    // 双轨同源断言：抽取轨正文的每个段落，都能在预览 HTML 的标签文本中出现
    // （diff 覆盖层按 textContent 匹配的可靠性依据）。
    const parsed = await parseWordFile(path)
    for (const paragraph of parsed.text.split('\n').filter((p) => p.trim().length > 0)) {
      expect(html).toContain(paragraph.trim())
    }
  })

  it('加粗 run 映射为 <strong>（行内强调转换保真）', async () => {
    const path = await writeBoldDoc()
    const html = await convertWordToHtml(path)
    expect(html).toContain('<strong>加粗文字</strong>')
    expect(html).toContain('普通正文')
  })

  it('非 docx 文件报 WORD_PREVIEW_FAILED（携带可读原因）', async () => {
    const path = join(workDir, 'garbage.docx')
    writeFileSync(path, 'this is not a zip archive')
    await expect(convertWordToHtml(path)).rejects.toThrow(/WORD_PREVIEW_FAILED:/)
  })

  it('不存在的文件报 WORD_PREVIEW_FAILED（统一错误语义）', async () => {
    await expect(convertWordToHtml(join(workDir, 'missing.docx'))).rejects.toThrow(
      /WORD_PREVIEW_FAILED:/
    )
  })
})
