// @ts-check
/**
 * 运行环境探测，必须在加载 pi 之前安装：
 * - 记录读取过的环境变量名（`process.env` 换成代理）；
 * - 记录 `fetch` 访问的地址（确认除 mock 端点外没有其他外发请求）；
 * - 对比加载前后的全局变量，找出 pi 新增的全局变量；
 * - 记录 DOM 相关全局变量是否存在。
 */

const DOM_GLOBALS = ['window', 'document', 'navigator', 'self', 'localStorage', 'XMLHttpRequest']

export function installProbe() {
  const globalsBefore = new Set(Reflect.ownKeys(globalThis).map(String))
  /** @type {Set<string>} */
  const envReads = new Set()
  const realEnv = process.env
  process.env = new Proxy(realEnv, {
    get(target, key, receiver) {
      if (typeof key === 'string') envReads.add(key)
      return Reflect.get(target, key, receiver)
    },
    has(target, key) {
      if (typeof key === 'string') envReads.add(key)
      return Reflect.has(target, key)
    },
  })

  /** @type {string[]} */
  const fetchUrls = []
  const realFetch = globalThis.fetch
  /** @type {typeof fetch} */
  const recordingFetch = (input, init) => {
    fetchUrls.push(input instanceof Request ? input.url : String(input))
    return realFetch(input, init)
  }
  globalThis.fetch = recordingFetch

  return {
    report() {
      return {
        processType: /** @type {any} */ (process).type ?? 'node',
        versions: {
          node: process.versions.node,
          electron: process.versions.electron ?? null,
          v8: process.versions.v8,
        },
        platform: `${process.platform}-${process.arch}`,
        domGlobals: Object.fromEntries(
          DOM_GLOBALS.map((name) => [name, typeof (/** @type {any} */ (globalThis)[name])]),
        ),
        addedGlobals: Reflect.ownKeys(globalThis)
          .map(String)
          .filter((name) => !globalsBefore.has(name)),
        envReads: [...envReads].sort(),
        fetchUrls,
      }
    },
  }
}
