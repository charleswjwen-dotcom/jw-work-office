import type { Tool, ToolSchema } from '@shared/agent'

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
      parameters: (t.inputSchema as { _def?: { typeName?: string } })._def
        ? zodToJsonSchema(t.inputSchema)
        : {}
    }))
  }
}

function zodToJsonSchema(schema: { _def: unknown }): Record<string, unknown> {
  const def = schema._def as {
    typeName?: string
    shape?: () => Record<string, { _def: unknown }>
    description?: string
  }
  if (def.typeName === 'ZodObject' && def.shape) {
    const shape = def.shape()
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, val] of Object.entries(shape)) {
      const fieldDef = (val as { _def: { typeName?: string; description?: string; innerType?: { _def: unknown } } })._def
      const isOptional = fieldDef.typeName === 'ZodOptional'
      const inner = isOptional ? fieldDef.innerType ?? val : val
      properties[key] = zodToJsonSchema(inner as { _def: unknown })
      if (!isOptional) required.push(key)
    }
    return { type: 'object', properties, required }
  }
  if (def.typeName === 'ZodString') return { type: 'string', description: def.description }
  if (def.typeName === 'ZodNumber') return { type: 'number', description: def.description }
  if (def.typeName === 'ZodBoolean') return { type: 'boolean', description: def.description }
  return {}
}
