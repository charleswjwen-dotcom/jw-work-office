import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { makeDocx } from './__fixtures__/make-docx'
import { applyParagraphEdits } from './word-writer'
import { parseWordFile } from './word-parser'

// T-S2-05 写入器单测：覆盖"改写正确 / 结构保留 / 越界 / 对齐防线 / 转义 /
// 空段计数对齐"六个维度，对应验收标准"部分接受后文档结构完整"。

let workDir: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mwo-word-writer-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

async function writeDoc(paragraphs: string[]): Promise<string> {
  const path = join(workDir, `doc-${Math.random().toString(36).slice(2)}.docx`)
  writeFileSync(path, await makeDocx(paragraphs))
  return path
}

// 构造带段落属性与字符属性的复杂 docx（make-docx 只产简单段，结构保留断言需要真实 pPr/rPr）。
async function writeStructuredDoc(): Promise<string> {
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
<w:p w:rsidR="00AB1234"><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>居中加粗标题</w:t></w:r><w:r><w:t>多余的第二 run</w:t></w:r></w:p>
<w:p><w:r><w:t>普通正文段落</w:t></w:r></w:p>
<w:sectPr/>
</w:body>
</w:document>`
  )
  const path = join(workDir, `structured-${Math.random().toString(36).slice(2)}.docx`)
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))
  return path
}

async function readDocumentXml(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(path))
  const entry = zip.file('word/document.xml')
  if (!entry) throw new Error('test fixture missing word/document.xml')
  return (await entry.async('string')) as string
}

describe('applyParagraphEdits（段落写入器）', () => {
  it('整段替换生效：重解析后段落文本已更新，contentHash 变化', async () => {
    const path = await writeDoc(['第一段保持不变', '第二段将被替换', '第三段保持不变'])
    const before = await parseWordFile(path)

    const result = await applyParagraphEdits(path, [
      { index: 1, text: '第二段已经替换完成', expectedBefore: '第二段将被替换' }
    ])

    const after = await parseWordFile(path)
    expect(after.text).toContain('第二段已经替换完成')
    expect(after.text).toContain('第一段保持不变')
    expect(after.text).toContain('第三段保持不变')
    expect(after.meta.paragraphCount).toBe(3)
    expect(result.contentHash).toBe(after.contentHash)
    expect(result.contentHash).not.toBe(before.contentHash)
    expect(result.paragraphCount).toBe(3)
    expect(result.byteSize).toBeGreaterThan(0)
    expect(result.modifiedAt).toBeTruthy()
  })

  it('同批次多段替换全部生效', async () => {
    const path = await writeDoc(['甲段落', '乙段落', '丙段落'])
    await applyParagraphEdits(path, [
      { index: 0, text: '甲段落（改）', expectedBefore: '甲段落' },
      { index: 2, text: '丙段落（改）', expectedBefore: '丙段落' }
    ])
    const after = await parseWordFile(path)
    expect(after.text).toContain('甲段落（改）')
    expect(after.text).toContain('乙段落')
    expect(after.text).toContain('丙段落（改）')
  })

  it('保留段落结构：w:pPr 与首 run 的 w:rPr 存活，多余 run 被清除', async () => {
    const path = await writeStructuredDoc()
    await applyParagraphEdits(path, [
      { index: 0, text: '改写后的居中标题', expectedBefore: '居中加粗标题多余的第二 run' }
    ])
    const xml = await readDocumentXml(path)

    expect(xml).toContain('<w:jc w:val="center"/>')
    expect(xml).toContain('<w:sz w:val="28"/>')
    expect(xml).toContain('<w:b/>')
    expect(xml).toContain('改写后的居中标题')
    expect(xml).not.toContain('多余的第二 run')
    expect(xml).toContain('<w:sectPr/>')
    // 原 <w:p> 上的 rsid 属性保留（结构完整性）。
    expect(xml).toContain('w:rsidR="00AB1234"')
    // 结构化文档的段落 1 不受影响。
    const after = await parseWordFile(path)
    expect(after.text).toContain('普通正文段落')
  })

  it('XML 特殊字符（& < >）转义往返无损', async () => {
    const path = await writeDoc(['安全段落'])
    const nasty = 'A & B < C > D "quoted" \'single\''
    await applyParagraphEdits(path, [{ index: 0, text: nasty, expectedBefore: '安全段落' }])
    const after = await parseWordFile(path)
    expect(after.text).toContain(nasty)
  })

  it('中英混排与换行内文本整段替换', async () => {
    const path = await writeDoc(['混合 段落 mixed paragraph'])
    await applyParagraphEdits(path, [
      {
        index: 0,
        text: '新的 mixed 内容 新段落',
        expectedBefore: '混合 段落 mixed paragraph'
      }
    ])
    const after = await parseWordFile(path)
    expect(after.text).toContain('新的 mixed 内容 新段落')
  })

  it('空段不占段落号：索引按非空段对齐（与 splitParagraphs 口径一致）', async () => {
    // 手工构造含空段的 document.xml：空段（无 w:t）+ 自闭合空段 + 非空段。
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
<w:body><w:p/><w:p><w:pPr><w:jc w:val="left"/></w:pPr></w:p><w:p><w:r><w:t>空段之后的正文</w:t></w:r></w:p></w:body>
</w:document>`
    )
    const path = join(workDir, `sparse-${Math.random().toString(36).slice(2)}.docx`)
    writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))

    // 非空段只有 1 个（"空段之后的正文"），index 0 应命中它而非首个空段。
    await applyParagraphEdits(path, [
      { index: 0, text: '空段之后已被改写', expectedBefore: '空段之后的正文' }
    ])
    const after = await parseWordFile(path)
    expect(after.text).toContain('空段之后已被改写')
    expect(after.text).not.toContain('空段之后的正文')
    const xml = await readDocumentXml(path)
    expect(xml).toContain('<w:jc w:val="left"/>')
  })

  it('段落越界报 LOCATION_NOT_FOUND（与工具端错误码同语义）', async () => {
    const path = await writeDoc(['唯一段落'])
    await expect(
      applyParagraphEdits(path, [{ index: 5, text: '越界' }])
    ).rejects.toThrow(/LOCATION_NOT_FOUND/)
  })

  it('expectedBefore 不一致报 WORD_ALIGN_MISMATCH，文件保持不变', async () => {
    const path = await writeDoc(['原始段落'])
    const beforeBuf = readFileSync(path)
    await expect(
      applyParagraphEdits(path, [{ index: 0, text: '新文本', expectedBefore: '被外部修改过的文本' }])
    ).rejects.toThrow(/WORD_ALIGN_MISMATCH/)
    expect(readFileSync(path).equals(beforeBuf)).toBe(true)
  })

  it('重复 index 报 WORD_EDIT_CONFLICT；空编辑集报 WORD_EDITS_EMPTY', async () => {
    const path = await writeDoc(['段落一', '段落二'])
    await expect(
      applyParagraphEdits(path, [
        { index: 0, text: 'a' },
        { index: 0, text: 'b' }
      ])
    ).rejects.toThrow(/WORD_EDIT_CONFLICT/)
    await expect(applyParagraphEdits(path, [])).rejects.toThrow(/WORD_EDITS_EMPTY/)
  })

  it('原子落盘：完成后无 .tmp 残留（崩溃残留由 recovery.ts 清理）', async () => {
    const path = await writeDoc(['原子性验证段'])
    await applyParagraphEdits(path, [{ index: 0, text: '原子性验证段（已改）' }])
    const tmpPath = `${path}.tmp`
    const { existsSync } = await import('node:fs')
    expect(existsSync(tmpPath)).toBe(false)
  })
})
