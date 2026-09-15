import { toJSONSchema } from 'zod'
import type { Tool, ToolSchema } from '@shared/agent'

// Tool Registry（架构 §3.3）。
//
// 设计意图（勿删）：
// - 核心调度层只依赖 Tool 抽象，不硬编码具体能力——注册什么就能被 LLM 调用什么；
// - toSchemas() 产出"对齐 MCP tool 描述"的 JSON Schema（§3.3 MCP 兼容层），
//   未来加 McpAdapter 即可把同一份注册表暴露给外部 MCP 宿主；
// - Schema 转换用 zod v4 官方 toJSONSchema（项目 zod 为 4.6.1）。
//   【历史教训】T-S0-05 PoC 曾手写 _def.typeName 判别式转换器，但 zod v4 已
//   移除 _def.typeName，导致判别恒假、工具 schema 实际一直是空对象——Mock 验证
//   发现不了（mock 不看 schema），接真 OpenAI 端点时 function calling 会拿不到
//   参数结构。此 bug 由 T-S2-04 接入真实 Provider 时修正，勿再手写内部结构判别。
// - 单个工具转换失败降级为空 schema（LLM 视为自由参数），不拖垮整个注册表。

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  list(): Tool[] {
    return Array.from(this.tools.values())
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  toSchemas(): ToolSchema[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchemaSafe(t.inputSchema)
    }))
  }
}

function zodToJsonSchemaSafe(schema: unknown): Record<string, unknown> {
  try {
    // zod v4 官方转换。io:'input'：工具入参按解析前形态描述（含 default 之类
    // 输入端语义），与 LLM 提供的 arguments 语义一致。
    const converted = toJSONSchema(schema as never, { io: 'input' }) as Record<string, unknown>
    return converted
  } catch {
    return {}
  }
}
