const store = new Map<string, string>()

const memoryLocalStorage: Storage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => void store.set(key, value),
  removeItem: (key) => void store.delete(key),
  clear: () => store.clear(),
  key: (index) => Array.from(store.keys())[index] ?? null,
  get length() {
    return store.size
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: memoryLocalStorage,
  configurable: true,
  writable: true
})

export { store as memoryStore }
