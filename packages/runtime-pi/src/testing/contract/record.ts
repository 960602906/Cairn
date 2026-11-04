/**
 * 录制一个场景（M1-02a）：模型 → 录制代理 → 上游，得到录制文件与直连时的运行结果。
 * 调用方随后回放一次，确认回放得到的轨迹与直连时完全一致。
 */
import { PI_VERSION } from '../../index.js'
import { CASSETTE_VERSION, type Cassette } from './cassette.js'
import { startRecordingProxy } from './record-proxy.js'
import { runScenario, type Scenario, type ScenarioRun } from './scenarios.js'

export interface RecordOptions {
  /** 上游根地址（合成上游或真实服务，可带路径前缀）。 */
  readonly upstream: string
  readonly apiKey: string
  /** 录制文件名，默认为场景名。 */
  readonly name?: string
  /** 模型 id，默认用场景中的。 */
  readonly model?: string
  readonly reasoning: boolean
  /** 写入录制文件的来源；合成上游为 `synthetic`。 */
  readonly source: string
}

export async function recordScenario(
  scenario: Scenario,
  options: RecordOptions,
): Promise<{ readonly cassette: Cassette; readonly live: ScenarioRun }> {
  const proxy = await startRecordingProxy(options.upstream)
  try {
    const model = options.model ?? scenario.model
    const live = await runScenario(scenario, {
      baseUrl: proxy.baseUrl,
      apiKey: options.apiKey,
      model,
      reasoning: options.reasoning,
    })
    const cassette: Cassette = {
      version: CASSETTE_VERSION,
      name: options.name ?? scenario.name,
      scenario: scenario.name,
      model,
      reasoning: options.reasoning,
      source: options.source,
      pi: PI_VERSION,
      interactions: proxy.interactions,
    }
    return { cassette, live }
  } finally {
    await proxy.close()
  }
}
