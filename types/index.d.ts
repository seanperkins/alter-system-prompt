export type Section = { id: string; text: string; scope: string }
export type ContextBlock = { name: string; text: string }
export type Injected = { type: string; origin: string; before: string; after: string }
/** How often a rule changed text this session. */
export type Hit = { id: string; kind: 'changed'; where: string; count: number; last: string }

declare module 'claude-code' {
  interface PluginState {
    'alter-system-prompt': {
      systemBefore: Shaped<Section[]>
      systemAfter: Shaped<Section[]>
      context: Shaped<ContextBlock[]>
      injected: Shaped<Injected[]>
      hits: Shaped<Hit[]>
    }
  }
}
