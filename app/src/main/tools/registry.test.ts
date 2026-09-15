import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from './registry'
import type { Tool } from '@shared/agent'

// ToolRegistry 单元测试：注册表生命周期 + toSchemas 的 JSON Schema 产出。

function dummyTool(name: string, inputSchema?: Tool['inputSchema']): Tool {
  return {
    name,
    description: `测试工具 ${name}`,
    category: 'deterministic',
    isDestructive: false,
    preview: true,
    inputSchema: inputSchema ?? z.object({ ok: z.boolean() }),
    async execute() {
      return {
        id: 'cs-x',
        toolName: name,
        status: 'pending',
        changes: [],
        createdAt: new Date().toISOString()
      }
    }
  }
}

describe('ToolRegistry', () => {
  it('register / get / list / unregister 生命周期', () => {
    const registry = new ToolRegistry()
    expect(registry.list()).toHaveLength(0)
    expect(registry.get('a')).toBeUndefined()

    const a = dummyTool('a')
    registry.register(a)
    registry.register(dummyTool('b'))

    expect(registry.get('a')).toBe(a)
    expect(registry.list()).toHaveLength(2)

    registry.unregister('a')
    expect(registry.get('a')).toBeUndefined()
    expect(registry.list()).toHaveLength(1)
  })

  it('同名注册覆盖旧实例（Map 语义，升级工具无需先反注册）', () => {
    const registry = new ToolRegistry()
    const first = dummyTool('a')
    const second = dummyTool('a')

    registry.register(first)
    registry.register(second)

    expect(registry.get('a')).toBe(second)
    expect(registry.list()).toHaveLength(1)
  })

  it('toSchemas 产出真实 JSON Schema（zod v4 回归护栏，勿再手写 _def 判别）', () => {
    const registry = new ToolRegistry()
    registry.register(
      dummyTool(
        'replaceText',
        z.object({
          location: z.object({ type: z.literal('paragraph'), index: z.number() }),
          find: z.string(),
          replacement: z.string()
        })
      )
    )

    const schemas = registry.toSchemas()
    expect(schemas).toHaveLength(1)
    expect(schemas[0].name).toBe('replaceText')
    expect(schemas[0].description).toContain('replaceText')

    const params = schemas[0].parameters as {
      type: string
      properties: Record<string, unknown>
      required: string[]
    }
    expect(params.type).toBe('object')
    expect(Object.keys(params.properties)).toContain('location')
    expect(Object.keys(params.properties)).toContain('find')
    expect(Object.keys(params.properties)).toContain('replacement')
    expect(params.required).toEqual(
      expect.arrayContaining(['location', 'find', 'replacement'])
    )
  })

  it('单个工具 schema 转换失败降级为空对象，不拖垮整个注册表', () => {
    const registry = new ToolRegistry()
    registry.register(dummyTool('good', z.object({ x: z.string() })))
    // z.bigint() 在 JSON Schema 中不可表示（zod v4 默认 throw）：
    // 降级路径 = 该工具 parameters 为 {}（LLM 视为自由参数），其余工具不受影响。
    registry.register(dummyTool('bad', z.bigint()))

    const schemas = registry.toSchemas()
    expect(schemas).toHaveLength(2)

    const byName = Object.fromEntries(
      schemas.map((s) => [s.name, s.parameters])
    ) as Record<string, Record<string, unknown>>
    expect(byName.good).toMatchObject({ type: 'object' })
    expect(byName.bad).toEqual({})
  })
})
