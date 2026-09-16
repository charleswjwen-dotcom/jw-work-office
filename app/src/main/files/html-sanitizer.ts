// 预览 HTML 消毒器（T-S2-08 右栏 Word 预览，架构 §2 安全红线 / PRD 7A.2）。
//
// 设计意图：
// - 渲染进程用 dangerouslySetInnerHTML 直渲染 mammoth 产出的 HTML，等价于把
//   HTML 注入 DOM——必须在**进入渲染进程之前**（主进程内）完成消毒，渲染层
//   不承担安全判断（架构 §2"渲染进程只消费白名单契约"的延续）。
// - 纯字符串实现而非 dompurify+jsdom：主进程无 DOM，且引入 jsdom 只为消毒
//   过重（拖慢启动与测试）。威胁模型是"mammoth 输出被上游投毒 / docx 内嵌
//   恶意构造"，标签白名单 + 属性全剥离足以覆盖：script/style/iframe 不可达
//   渲染层，事件属性（onclick 等）全部被剥离，img 仅放行位图 data URI
//   （svg+xml 被明确排除——SVG 可内嵌脚本）。
// - 返回 null 表示"消毒后无可渲染内容"，由上层映射 PREVIEW_HTML_REJECTED，
//   绝不把空白静默当作成功（T-S2-08 验收"预览 diff 可见"）。

// 允许的标签白名单：mammoth convertToHtml 的合法输出域（段落/标题/列表/
// 表格/行内强调/引用）。保留时全部重建为无属性裸标签——仅 td/th 的
// colspan/rowspan（纯数字）与受控 img 例外。
const ALLOWED_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'sup',
  'sub',
  'br'
])

// 连内容一起整体丢弃的危险容器。style 虽非脚本，但 CSS 可用于数据外带与
// UI 伪造（伪造按钮/遮罩），预览场景一并拒绝。
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
// 危险标签残片（无配对闭合的开启标签 / 孤立闭合标签）：只剥标签，内容已由
// 上一条规则或 token 重建处理。
const DROP_TAG_ONLY = /<\/?(?:script|style|iframe|object|embed)\b[^>]*>/gi
// 标签 token：`<` `</`? 标签名 任意非">" `>`。[^>]* 不跨 ">"，与浏览器
// 分词一致；属性值内藏 ">" 的构造会在此提前截断，残余部分只会成为文本。
const TAG_TOKEN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g
// img 的 data URI 白名单：仅位图 base64。svg+xml 被排除（SVG 可内嵌脚本）。
const SAFE_IMG_SRC = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/
// td/th 上唯一放行的属性形态：引号包裹的纯数字 colspan/rowspan。
const SPAN_ATTR = /^(?:colspan|rowspan)="\d+"$/

function escapeStrayLt(text: string): string {
  // 非标签文本中的裸 "<" 一律转义：未闭合的标签残片（如 "<img onerror=..."）
  // 在浏览器分词中可能被补救解析成标签，转义后彻底失去标签语义。
  return text.replace(/</g, '&lt;')
}

function renderOpeningTag(name: string, rest: string): string {
  if (name === 'br') {
    return '<br>'
  }
  if (name === 'td' || name === 'th') {
    // 表格合并属性白名单：仅 colspan/rowspan 且值必须是纯数字，其余全剥离。
    const attrs = rest
      .split(/\s+/)
      .filter((attr) => SPAN_ATTR.test(attr))
      .join(' ')
    return attrs ? `<${name} ${attrs}>` : `<${name}>`
  }
  // 其余白名单标签：全部属性剥离，重建为裸标签。
  return `<${name}>`
}

function renderImgTag(rest: string): string {
  const match = /\ssrc\s*=\s*["']([^"']*)["']/i.exec(rest)
  const src = match?.[1] ?? ''
  if (!SAFE_IMG_SRC.test(src)) {
    return ''
  }
  return `<img src="${src}" alt="">`
}

export function sanitizePreviewHtml(html: string): string | null {
  let src = html
  // ① 注释整体丢弃（含未闭合到文件尾的注释，防止"注释内藏标签"被后续激活）。
  src = src.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
  // ② DOCTYPE / CDATA 等 <!...> 声明丢弃。
  src = src.replace(/<![^>]*>/g, '')
  // ③ 危险容器连内容一起删除，再扫一遍残片（无闭合开启标签 / 孤立闭合标签）。
  src = src.replace(DROP_WITH_CONTENT, '').replace(DROP_TAG_ONLY, '')

  // ④ 逐 token 重建：白名单标签重建为裸标签；a 剥壳留文本（预览无导航，
  // href 的价值在跳转，右栏预览不需要）；img 校验 data URI；未知标签剥壳
  // 保留内容；标签之间的文本转义裸 "<"。
  let out = ''
  let last = 0
  for (const token of src.matchAll(TAG_TOKEN)) {
    const index = token.index ?? 0
    out += escapeStrayLt(src.slice(last, index))
    const [full, slash, rawName, rest] = token
    const name = rawName.toLowerCase()
    if (slash) {
      out += ALLOWED_TAGS.has(name) ? `</${name}>` : ''
    } else if (name === 'img') {
      out += renderImgTag(rest)
    } else if (name === 'a') {
      out += ''
    } else if (ALLOWED_TAGS.has(name)) {
      out += renderOpeningTag(name, rest)
    }
    last = index + full.length
  }
  out += escapeStrayLt(src.slice(last))

  const result = out.trim()
  return result.length > 0 ? result : null
}
