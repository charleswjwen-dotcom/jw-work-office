import { describe, expect, it } from 'vitest'
import { sanitizePreviewHtml } from './html-sanitizer'

// T-S2-08 预览消毒器单测：覆盖"危险容器连内容删除 / a 剥壳留文本 / 属性全
// 剥离 / img data URI 白名单 / colspan 数字校验 / 未知标签剥壳 / 注释与
// DOCTYPE 丢弃 / 空结果判 null / 未闭合残片转义"九个维度，对应架构 §2
// 安全红线（渲染层只消费消毒后 HTML）与 PRD 7A.2 隐私边界。

describe('sanitizePreviewHtml（预览 HTML 消毒器）', () => {
  it('script 连内容整体删除（含大小写混合与无闭合残片）', () => {
    expect(sanitizePreviewHtml('<p>前段</p><script>alert(1)</script><p>后段</p>')).toBe(
      '<p>前段</p><p>后段</p>'
    )
    expect(sanitizePreviewHtml('<p>a</p><SCRIPT>alert(1)</SCRIPT><p>b</p>')).toBe('<p>a</p><p>b</p>')
    expect(sanitizePreviewHtml('<p>a</p><script src="https://evil.example/x.js"><p>b</p>')).toBe(
      '<p>a</p><p>b</p>'
    )
  })

  it('style/iframe/object/embed 连内容删除（embed 空元素剥标签）', () => {
    const html =
      '<style>body{background:url(https://evil)}</style>' +
      '<iframe src="https://evil"></iframe>' +
      '<object data="x"><param name="a" value="b"></object>' +
      '<embed src="x">' +
      '<p>正文</p>'
    expect(sanitizePreviewHtml(html)).toBe('<p>正文</p>')
  })

  it('a 标签剥壳保留内文（预览无导航，href 一律丢弃）', () => {
    expect(sanitizePreviewHtml('<p>见<a href="https://evil.example">这份文档</a>细节</p>')).toBe(
      '<p>见这份文档细节</p>'
    )
  })

  it('白名单标签保留，属性全部剥离（事件属性不可达）', () => {
    const html =
      '<table onclick="alert(1)" class="evil"><tr><td onmouseover="steal()">单元格</td></tr></table>'
    expect(sanitizePreviewHtml(html)).toBe('<table><tr><td>单元格</td></tr></table>')
  })

  it('嵌套列表与行内强调原样保留（mammoth 合法输出域）', () => {
    const html =
      '<ul><li>甲</li><li><ol><li>乙</li></ol></li></ul><p><strong>粗</strong><em>斜</em></p>'
    expect(sanitizePreviewHtml(html)).toBe(html)
  })

  it('img 仅放行位图 data URI：http/javascript/svg 一律拒绝', () => {
    const data = '<img src="data:image/png;base64,iVBORw0KGgo=">'
    expect(sanitizePreviewHtml(data)).toBe('<img src="data:image/png;base64,iVBORw0KGgo=" alt="">')

    expect(sanitizePreviewHtml('<img src="https://evil.example/x.png">')).toBeNull()
    expect(sanitizePreviewHtml('<img src="javascript:alert(1)">')).toBeNull()
    expect(sanitizePreviewHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">')).toBeNull()
  })

  it('td/th 仅放行纯数字 colspan/rowspan，其余属性剥离', () => {
    expect(sanitizePreviewHtml('<td colspan="3" rowspan="2" bgcolor="red">x</td>')).toBe(
      '<td colspan="3" rowspan="2">x</td>'
    )
    expect(sanitizePreviewHtml('<th colspan="abc">y</th>')).toBe('<th>y</th>')
  })

  it('未知标签剥壳保留内容（div/span/section 等）', () => {
    expect(sanitizePreviewHtml('<div>块</div><span>行内</span>')).toBe('块行内')
  })

  it('注释与 DOCTYPE 丢弃（含注释内藏 script 的构造）', () => {
    expect(sanitizePreviewHtml('<!-- <script>alert(1)</script> --><!DOCTYPE html><p>a</p>')).toBe(
      '<p>a</p>'
    )
  })

  it('未闭合的标签残片被转义为文本（失去标签语义）', () => {
    expect(sanitizePreviewHtml('a < b')).toBe('a &lt; b')
    expect(sanitizePreviewHtml('<p>ok</p><img onerror=alert(1)')).toBe(
      '<p>ok</p>&lt;img onerror=alert(1)'
    )
  })

  it('消毒后无内容返回 null（上层映射 PREVIEW_HTML_REJECTED）', () => {
    expect(sanitizePreviewHtml('')).toBeNull()
    expect(sanitizePreviewHtml('   \n  ')).toBeNull()
    expect(sanitizePreviewHtml('<script>alert(1)</script>')).toBeNull()
  })
})
